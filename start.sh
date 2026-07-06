#!/bin/bash
# AI 냉장고 실행 스크립트
cd "$(dirname "$0")"
exec node server.js "$@"
