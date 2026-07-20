import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const cssUrl = new URL("../styles.css", import.meta.url);


test("conversation blocks keep their side while body text stays left aligned at 12px", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(css, /\.chat-message\.is-user\s*{[^}]*justify-items:\s*end;/s);
  assert.match(css, /\.message-speaker\s*{[^}]*font-size:\s*10px;/s);
  assert.match(css, /\.message-body\s*{[^}]*font-size:\s*12px;/s);
  assert.match(css, /\.chat-message\.is-user \.message-body\s*{[^}]*text-align:\s*left;/s);
});
