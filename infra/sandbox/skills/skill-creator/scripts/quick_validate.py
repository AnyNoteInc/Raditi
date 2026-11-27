#!/usr/bin/env python3
"""Check a skill folder by the rules Радити installs a skill by.

Usage: python3 quick_validate.py <skill-folder>

Prints what is wrong, one line each, and exits 1; prints "ok" and exits 0 when the skill would be
accepted. The rules are those of docs/plan/97-skills.md (Нв3, Нв10, Нв15): the open standard of
agentskills.io for the header, and the bounds of a skill of an account.

Written for Радити after quick_validate.py of the skill-creator of Anthropic and of OpenAI
(Apache-2.0): see NOTICE.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
RESERVED = {
    "compact", "undo", "redo", "cancel", "new", "sessions", "export", "models", "usage",
    "status", "context", "details", "thinking", "themes", "help", "start", "stop", "delete",
    "chats", "release", "preview", "update", "reset", "rollback", "init", "retry",
    "summarize", "clear", "resume", "continue", "mo",
    "customize-opencode", "skill", "skills", "skill-creator", "commercial-offer",
    "product-cards", "social-posts",
}
JUNK = {".git", "__pycache__", "node_modules", ".venv", "__MACOSX", ".DS_Store"}
MAX_FILES = 100
MAX_FILE = 5 * 1024 * 1024
MAX_SKILL = 10 * 1024 * 1024
MAX_SKILL_MD = 256 * 1024
MAX_PATH = 255
MAX_PARTS = 10


def files_of(root: Path):
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if any(part in JUNK for part in rel.parts) or rel.name.endswith(".pyc"):
            continue
        yield path, rel


def read_header(root: Path) -> tuple[dict | None, list[str]]:
    """The header of SKILL.md as a dict, or None with what is wrong."""
    skill_md = root / "SKILL.md"
    if not skill_md.is_file():
        return None, ["SKILL.md is missing at the root of the folder"]
    problems: list[str] = []
    raw = skill_md.read_bytes()
    if len(raw) > MAX_SKILL_MD:
        problems.append(f"SKILL.md is {len(raw)} bytes, at most {MAX_SKILL_MD}")
    text = raw.decode("utf-8", errors="replace").lstrip("\ufeff")
    match = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(\r?\n|$)", text, re.DOTALL)
    if not match:
        return None, problems + ["SKILL.md does not start with a header between two lines of ---"]
    try:
        header = yaml.safe_load(match.group(1))
    except yaml.YAMLError as error:
        return None, problems + [f"the header is not valid YAML: {error}"]
    if not isinstance(header, dict):
        return None, problems + ["the header is not a set of fields"]
    return header, problems


def check_name(root: Path, name: object) -> list[str]:
    if not isinstance(name, str) or not NAME.match(name.strip()) or len(name.strip()) > 64:
        return ["name: lowercase Latin letters, digits and single hyphens, 1-64 characters"]
    name = name.strip()
    problems: list[str] = []
    if name != root.name:
        problems.append(f"name '{name}' differs from the folder '{root.name}'")
    if name in RESERVED:
        problems.append(f"name '{name}' is taken by a command of the chat or a skill of the platform")
    return problems


def check_description(description: object) -> list[str]:
    if not isinstance(description, str) or not description.strip():
        return ["description is missing"]
    description = description.strip()
    problems: list[str] = []
    if len(description) > 1024:
        problems.append(f"description is {len(description)} characters, at most 1024")
    if "<" in description or ">" in description:
        problems.append("description has < or >")
    if "TODO" in description:
        problems.append("description still has the TODO of the template")
    if "use" not in description.lower() and "когда" not in description.lower():
        problems.append("description should say when to use the skill (warning)")
    return problems


def check_optional(header: dict) -> list[str]:
    problems: list[str] = []
    compatibility = header.get("compatibility")
    if compatibility is not None and (not isinstance(compatibility, str) or len(compatibility) > 500):
        problems.append("compatibility: one text up to 500 characters")
    metadata = header.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        problems.append("metadata: a set of fields")
    elif isinstance(metadata, dict) and any("TODO" in str(value) for value in metadata.values()):
        problems.append("metadata still has the TODO of the template")
    return problems


def check_file(path: Path, rel: Path) -> tuple[list[str], int]:
    """What is wrong with one file, and its size."""
    if path.is_symlink():
        return [f"{rel}: a link; put the file itself into the skill"], 0
    size = path.stat().st_size
    text_rel = rel.as_posix()
    problems: list[str] = []
    if len(text_rel) > MAX_PATH or len(rel.parts) > MAX_PARTS or "\\" in text_rel:
        problems.append(f"{text_rel}: the path is too long or too deep")
    if size > MAX_FILE:
        problems.append(f"{text_rel}: {size} bytes, at most {MAX_FILE} per file")
    return problems, size


def check_files(root: Path) -> list[str]:
    problems: list[str] = []
    count = 0
    total = 0
    for path, rel in files_of(root):
        if path.is_dir() and not path.is_symlink():
            continue
        count += 1
        found, size = check_file(path, rel)
        problems += found
        total += size
    if count > MAX_FILES:
        problems.append(f"{count} files, at most {MAX_FILES}")
    if total > MAX_SKILL:
        problems.append(f"{total} bytes together, at most {MAX_SKILL}")
    return problems


def check(root: Path) -> list[str]:
    header, problems = read_header(root)
    if header is None:
        return problems
    return (
        problems
        + check_name(root, header.get("name"))
        + check_description(header.get("description"))
        + check_optional(header)
        + check_files(root)
    )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python3 quick_validate.py <skill-folder>")
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"{root}: not a folder")
        return 1
    problems = check(root)
    errors = [p for p in problems if not p.endswith("(warning)")]
    for problem in problems:
        print(problem)
    if errors:
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
