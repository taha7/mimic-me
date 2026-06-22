#!/bin/bash

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path')

if echo "$FILE_PATH" | grep -qE '\.env($|\.)'; then
  echo "BLOCKED: Reading '$FILE_PATH' is not allowed. The user has prevented you from reading .env files." >&2
  exit 2
fi

exit 0
