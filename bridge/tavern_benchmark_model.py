"""SillyTavern's existing custom model route for the isolated benchmark."""

import http.cookiejar
import json
from pathlib import Path
import urllib.request


class TavernModel:
    def __init__(self, root, port, no_thinking=False):
        settings = json.loads((Path(root) / "data/default-user/settings.json").read_text(encoding="utf-8-sig"))
        api = settings["oai_settings"]
        if settings.get("main_api") != "openai" or api.get("chat_completion_source") != "custom":
            raise ValueError("This harness expects a configured SillyTavern Custom Chat Completion profile")
        self.configuration = {key: api[key] for key in ("custom_url", "custom_include_body", "custom_include_headers", "custom_exclude_body", "custom_prompt_post_processing") if api.get(key)}
        self.configuration.update(model=api["custom_model"], chat_completion_source="custom")
        if no_thinking:
            if self.configuration.get("custom_include_body"):
                raise ValueError("Explicitly merge existing custom request settings before disabling thinking")
            self.configuration["custom_include_body"] = '{"thinking":{"type":"disabled"},"reasoning_effort":"none"}'
        self.base = f"http://127.0.0.1:{port}"
        self.session = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        with self.session.open(self.base + "/csrf-token", timeout=8) as reply:
            self.csrf = json.load(reply)["token"]

    def complete(self, prompt, max_tokens=140):
        body = dict(self.configuration, messages=[{"role": "user", "content": prompt}], stream=False, temperature=0, max_tokens=max_tokens)
        request = urllib.request.Request(
            self.base + "/api/backends/chat-completions/generate",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"content-type": "application/json", "x-csrf-token": self.csrf},
        )
        with self.session.open(request, timeout=45) as reply:
            result = json.load(reply)
        if not result.get("choices"):
            error = result.get("error")
            code = error.get("code", "unknown") if isinstance(error, dict) else "unknown"
            raise RuntimeError(f"The configured provider returned no choices (code={code})")
        return result["choices"][0]["message"].get("content") or "", result.get("usage") or {}
