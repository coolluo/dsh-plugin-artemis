"""Trim maintainer-only sections out of the published README.

Removes the "发布" / "用非 Gemini 的模型" / "开发" sections (lines between the
"## 发布" heading and the "## 已验证" heading) so npm shows a user-facing README.
The moved content lives in docs/RELEASING.md, docs/USING-DEEPSEEK.md and
docs/DEVELOPING.md.
"""

import re

PATH = r"C:\person_project\dsh-plugin-artemis\README.md"

text = open(PATH, encoding="utf-8").read()
lines = text.splitlines()

start = next(i for i, line in enumerate(lines) if line.strip() == "## 发布")
end = next(i for i, line in enumerate(lines) if line.strip() == "## 已验证")

# Keep one blank line before the next heading.
kept = lines[:start] + lines[end:]
while len(kept) > 1 and kept[start - 1].strip() == "" and kept[start].strip() == "":
    kept.pop(start - 1)

open(PATH, "w", encoding="utf-8", newline="\n").write("\n".join(kept) + "\n")
print("removed lines", start + 1, "to", end, "->", len(lines) - (end - start), "lines left")
print("sections now:")
for line in kept:
    if line.startswith("## "):
        print("  ", line)
