#!/bin/sh
# Prepares verify/ inside <scratch>/harness/verify: copies of the product files the checks draw
# with (the real DocumentMarkdown and rehypeDocumentRules, sectionMarkdownProblem), the
# @repo/domain link, and the serializer-2.1.2 directory. Usage: sh setup.sh <repository root>
set -eu
REPO="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
D="$HERE/repo/packages/domain/src"
mkdir -p "$D/tasks" "$D/pages" "$HERE/repo/packages/doc-render/src" "$HERE/node_modules/@repo"
cp "$REPO/packages/domain/src/errors.ts" "$D/"
cp "$REPO/packages/domain/src/tasks/chat-documents.ts" "$D/tasks/"
cp "$REPO/packages/domain/src/pages/path.ts" "$REPO/packages/domain/src/pages/limits.ts" "$REPO/packages/domain/src/pages/doc.ts" "$D/pages/"
cp "$REPO/packages/doc-render/src/document-markdown.ts" "$REPO/packages/doc-render/src/rules.ts" "$HERE/repo/packages/doc-render/src/"
printf '%s\n' '{ "name": "@repo/domain", "type": "module", "exports": { "./tasks/chat-documents": "./src/tasks/chat-documents.ts", "./pages/path": "./src/pages/path.ts" } }' > "$HERE/repo/packages/domain/package.json"
ln -sfn ../../repo/packages/domain "$HERE/node_modules/@repo/domain"
mkdir -p "$HERE/s212/lib"
cp "$HERE/../lib/canon.mjs" "$HERE/../lib/remark-bridge.mjs" "$HERE/s212/lib/"
cp "$HERE/../constructs.mjs" "$HERE/s212/"
rm -rf "$HERE/s212/corpus" && cp -R "$HERE/../corpus" "$HERE/s212/corpus"
