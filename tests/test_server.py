import copy
from concurrent.futures import ThreadPoolExecutor
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError


MODULE_PATH = Path(__file__).resolve().parents[1] / "server.py"
SPEC = importlib.util.spec_from_file_location("hia_demo_server", MODULE_PATH)
server_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server_module
SPEC.loader.exec_module(server_module)


def request_fixture():
    return {
        "requestId": "decision-1", "runId": "run-1", "passengerId": "p-1",
        "observation": {"time": 60, "publishedGate": "a_1"},
        "allowedActions": ["go_to_announced_gate", "read_board", "wait"],
    }


class ValidationTests(unittest.TestCase):
    def test_provider_identity_is_derived_only_from_exact_hostname(self):
        self.assertEqual(server_module.ProviderConfig(endpoint="https://inference.nosana.com/v1/chat/completions").public_status()["provider"], "Nosana hosted inference")
        self.assertNotEqual(server_module.ProviderConfig(endpoint="https://inference.nosana.com.example.org/x").public_status()["provider"], "Nosana hosted inference")

    def test_missing_configuration_is_honest(self):
        status = server_module.ProviderConfig().public_status()
        self.assertFalse(status["configured"])
        self.assertEqual(status["status"], "missing_configuration")
        self.assertEqual(status["connectivity"], "not_probed")

    def test_remote_plain_http_and_embedded_credentials_rejected(self):
        for endpoint in ("http://example.org/infer", "https://name:password@example.org/infer", "file:///tmp/model", "https://example.org/x#key"):
            self.assertEqual(server_module.ProviderConfig(endpoint=endpoint).problem(), "invalid_configuration")

    def test_openai_requires_model_and_configuration_is_not_connectivity(self):
        config = server_module.ProviderConfig(endpoint="https://example.org/v1/chat/completions", protocol="openai_compatible")
        self.assertEqual(config.problem(), "missing_model")
        config = server_module.ProviderConfig(endpoint="https://example.org/v1/chat/completions", protocol="openai_compatible", model="example")
        self.assertEqual(config.public_status()["status"], "configured_unverified")

    def test_request_strict_identity_shape_and_actions(self):
        self.assertEqual(server_module.validate_request(request_fixture()), request_fixture())
        invalid = []
        for key, value in (("runId", 4), ("requestId", ""), ("passengerId", "bad\nidentity"), ("observation", []), ("allowedActions", ["execute_code"]), ("allowedActions", ["wait", "wait"])):
            item = request_fixture(); item[key] = value; invalid.append(item)
        item = request_fixture(); item["secret"] = "not-an-accepted-field"; invalid.append(item)
        item = request_fixture(); item["observation"] = {"n": float("nan")}; invalid.append(item)
        item = request_fixture(); item["observation"] = {"text": "x" * server_module.MAX_REQUEST_BYTES}; invalid.append(item)
        for item in invalid:
            with self.assertRaises(server_module.InvalidRequest):
                server_module.validate_request(item)

    def test_wait_and_response_boundaries(self):
        for seconds in (0, 31, True, "5", float("nan")):
            with self.assertRaises(server_module.InvalidResponse):
                server_module.validate_response({"action": {"type": "wait", "seconds": seconds}}, request_fixture())
        self.assertEqual(server_module.validate_response({"action": {"type": "wait", "seconds": 10}}, request_fixture())["action"]["seconds"], 10)
        with self.assertRaises(server_module.InvalidResponse):
            server_module.validate_response({"action": {"type": "execute_code"}}, request_fixture())

    def test_response_echoes_only_current_request_and_strips_parameters(self):
        response = server_module.validate_response({"runId": "upstream-wrong", "action": {"type": "go_to_announced_gate", "code": "never-executed", "gate": "hidden"}, "summary": "a" * 200}, request_fixture())
        self.assertEqual(response["runId"], "run-1")
        self.assertEqual(response["action"], {"type": "go_to_announced_gate"})
        self.assertEqual(len(response["summary"]), 160)

    def test_model_content_requires_json_not_extra_prose(self):
        body = '{"action":{"type":"read_board"}}'
        self.assertEqual(server_module.parse_model_content("```json\n" + body + "\n```"), json.loads(body))
        with self.assertRaises(server_module.InvalidResponse):
            server_module.parse_model_content("I think... " + body)

    def test_provider_timeout_and_errors_are_sanitized(self):
        config = server_module.ProviderConfig(endpoint="https://example.org/infer")
        cases = [(socket.timeout("sensitive-url"), 504, "provider_timeout"), (URLError(socket.timeout("private")), 504, "provider_timeout"), (HTTPError("https://private", 401, "secret detail", {}, None), 502, "provider_rejected_request")]
        for error, status, code in cases:
            with patch.object(server_module, "build_opener") as opener:
                opener.return_value.open.side_effect = error
                with self.assertRaises(server_module.ProviderFailure) as caught:
                    server_module.call_provider(config, request_fixture())
                self.assertEqual((caught.exception.status, caught.exception.code), (status, code))
                self.assertNotIn("private", str(caught.exception))

    def test_request_budget_is_atomic_and_caps_concurrent_attempts(self):
        budget = server_module.RequestBudget(30)
        def attempt(_):
            try:
                budget.reserve(); return True
            except server_module.ProviderFailure as exc:
                self.assertEqual((exc.status, exc.code), (429, "request_limit_reached")); return False
        with ThreadPoolExecutor(max_workers=20) as pool:
            results = list(pool.map(attempt, range(100)))
        self.assertEqual(sum(results), 30)
        self.assertEqual(budget.public_status(), {"requestCap": 30, "upstreamAttempts": 30, "remainingRequests": 0})

    def test_missing_config_does_not_consume_attempt_but_upstream_failure_does(self):
        budget = server_module.RequestBudget(2)
        with self.assertRaises(server_module.ProviderFailure):
            server_module.call_provider(server_module.ProviderConfig(), request_fixture(), budget)
        self.assertEqual(budget.attempts, 0)
        with patch.object(server_module, "build_opener") as opener:
            opener.return_value.open.side_effect = URLError("fixture-unavailable")
            with self.assertRaises(server_module.ProviderFailure):
                server_module.call_provider(server_module.ProviderConfig(endpoint="https://example.org/infer"), request_fixture(), budget)
        self.assertEqual(budget.attempts, 1)


class ProtectedConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.web = self.root / "web"; self.web.mkdir()
        self.file = self.root / "fixture-config.json"
        self.data = {"HIA_AGENT_ENDPOINT": "https://example.org/infer", "HIA_AGENT_PROTOCOL": "json", "HIA_AGENT_MODEL": "fixture-model", "HIA_AGENT_API_KEY": "fixture-only-key"}
        self.file.write_text(json.dumps(self.data)); self.file.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def test_private_config_loads_without_exposing_key_or_merging_environment(self):
        with patch.dict(server_module.os.environ, {"HIA_AGENT_ENDPOINT": "https://different.example.org"}):
            config = server_module.ProviderConfig.from_protected_file(self.file, self.web)
        self.assertEqual(config.endpoint, self.data["HIA_AGENT_ENDPOINT"])
        self.assertEqual(config.api_key, "fixture-only-key")
        self.assertNotIn("fixture-only-key", json.dumps(config.public_status()))
        self.file.chmod(0o400)
        self.assertIsNone(server_module.ProviderConfig.from_protected_file(self.file, self.web).problem())

    def test_public_permissions_symlink_and_served_root_config_are_rejected(self):
        self.file.chmod(0o640)
        with self.assertRaises(ValueError):
            server_module.ProviderConfig.from_protected_file(self.file, self.web)
        self.file.chmod(0o600)
        link = self.root / "config-link"; link.symlink_to(self.file)
        with self.assertRaises(ValueError):
            server_module.ProviderConfig.from_protected_file(link, self.web)
        inside = self.web / "config.json"; inside.write_text(json.dumps(self.data)); inside.chmod(0o600)
        with self.assertRaises(ValueError):
            server_module.ProviderConfig.from_protected_file(inside, self.web)

    def test_bad_config_is_rejected_with_sanitized_message(self):
        for text in ('{"invalid": "fixture-only-key"}', '{"HIA_AGENT_ENDPOINT": 123}', "fixture-only-key", "[]", json.dumps({"HIA_AGENT_ENDPOINT": "http://example.org/infer"})):
            self.file.write_text(text)
            with self.assertRaises(ValueError) as caught:
                server_module.ProviderConfig.from_protected_file(self.file, self.web)
            self.assertNotIn("fixture-only-key", str(caught.exception))


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "web"
        self.root.mkdir()
        (self.root / "index.html").write_text("<h1>isolated fixture</h1>")
        (self.root / "main.js").write_text("export const safe = true;")
        (self.root / ".env").write_text("fixture-hidden")
        (Path(self.temp.name) / "server.py").write_text("fixture-not-web")
        (self.root / "escape").symlink_to(Path(self.temp.name) / "server.py")
        self.httpd = server_module.create_server(self.root, server_module.ProviderConfig(), port=0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.thread.join(timeout=1)
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        status, data, response_headers = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return status, data, response_headers

    def test_status_and_static_page_are_available_without_provider(self):
        status, data, _ = self.request("GET", "/api/agent/status")
        self.assertEqual(status, 200); self.assertFalse(json.loads(data)["configured"])
        status, data, headers = self.request("GET", "/")
        self.assertEqual(status, 200); self.assertIn(b"isolated fixture", data)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.request("HEAD", "/")[1], b"")
        self.assertEqual(self.request("GET", "/main.js")[2]["Content-Type"], "text/javascript")

    def test_static_hidden_parent_symlink_and_source_paths_not_served(self):
        for path in ("/.env", "/%2eenv", "/../server.py", "/%2e%2e/server.py", "/server.py", "/escape", "/x%5c..%5cserver.py", "/api/no-such-route"):
            self.assertEqual(self.request("GET", path)[0], 404, path)

    def test_host_and_origin_are_exact(self):
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"}, {"Origin": "null"}, {"Origin": f"http://localhost:{self.port}"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("GET", "/api/agent/status", headers=headers)[0], 403)
        self.assertEqual(self.request("GET", "/api/agent/status", headers={"Origin": f"http://127.0.0.1:{self.port}"})[0], 200)

    def test_absent_endpoint_returns_503_with_identity_no_live_claim(self):
        status, data, headers = self.request("POST", "/api/agent/decide", json.dumps(request_fixture()), {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"})
        result = json.loads(data)
        self.assertEqual(status, 503); self.assertEqual(result["error"], "missing_configuration")
        self.assertEqual(result["runId"], "run-1"); self.assertEqual(result["source"], "unavailable")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        status = json.loads(self.request("GET", "/api/agent/status")[1])
        self.assertEqual(status["remainingRequests"], 30)

    def test_http_request_limit_stops_before_another_upstream_attempt(self):
        self.httpd.RequestHandlerClass.keywords["provider_config"] = server_module.ProviderConfig(endpoint="https://example.org/infer")
        self.httpd.request_budget.limit = 2
        with patch.object(server_module, "build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value.read.return_value = b'{"action":{"type":"read_board"}}'
            statuses = [self.request("POST", "/api/agent/decide", json.dumps(request_fixture()), {"Content-Type": "application/json"})[0] for _ in range(3)]
            self.assertEqual(statuses, [200, 200, 429])
            self.assertEqual(opener.return_value.open.call_count, 2)
        status = json.loads(self.request("GET", "/api/agent/status")[1])
        self.assertEqual(status["remainingRequests"], 0)
        self.assertEqual(status["upstreamAttempts"], 2)

    def test_invalid_json_shape_size_and_type(self):
        self.assertEqual(self.request("POST", "/api/agent/decide", "not JSON", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/agent/decide", "{}", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/agent/decide", "x" * (server_module.MAX_REQUEST_BYTES + 1), {"Content-Type": "application/json"})[0], 413)
        self.assertEqual(self.request("POST", "/api/agent/decide", "{}", {"Content-Type": "text/plain"})[0], 415)


class UpstreamTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        test = self
        class FakeUpstream(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                test.seen.append({"path": self.path, "body": json.loads(body), "authorization": self.headers.get("Authorization")})
                if self.path == "/redirect":
                    self.send_response(302); self.send_header("Location", "/credential-trap"); self.end_headers(); return
                if self.path == "/invalid":
                    value = {"action": {"type": "execute_code"}}
                elif self.path == "/openai":
                    value = {"choices": [{"message": {"content": '{"action":{"type":"read_board"},"summary":"Inspect the board."}'}}]}
                else:
                    value = {"action": {"type": "wait", "seconds": 5}, "summary": "Wait briefly."}
                encoded = json.dumps(value).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(encoded))); self.end_headers(); self.wfile.write(encoded)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.thread.join(timeout=1)

    def test_json_endpoint_and_bearer_stay_server_side(self):
        result = server_module.call_provider(server_module.ProviderConfig(endpoint=self.base + "/json", api_key="fixture-key"), request_fixture())
        self.assertEqual(result["action"], {"type": "wait", "seconds": 5})
        self.assertEqual(self.seen[0]["authorization"], "Bearer fixture-key")
        self.assertNotIn("fixture-key", json.dumps(result))
        self.assertEqual(self.seen[0]["body"], request_fixture())

    def test_openai_compatible_content_is_parsed_without_schema_assumption(self):
        config = server_module.ProviderConfig(endpoint=self.base + "/openai", protocol="openai_compatible", model="fixture-model")
        result = server_module.call_provider(config, request_fixture())
        self.assertEqual(result["action"]["type"], "read_board")
        self.assertEqual(self.seen[0]["body"]["model"], "fixture-model")
        self.assertNotIn("response_format", self.seen[0]["body"])

    def test_redirect_is_not_followed_and_invalid_action_rejected(self):
        for path, code in (("/redirect", "provider_rejected_request"), ("/invalid", "invalid_provider_response")):
            with self.assertRaises(server_module.ProviderFailure) as caught:
                server_module.call_provider(server_module.ProviderConfig(endpoint=self.base + path), request_fixture())
            self.assertEqual(caught.exception.code, code)
        self.assertEqual([r["path"] for r in self.seen], ["/redirect", "/invalid"])


if __name__ == "__main__":
    unittest.main()
