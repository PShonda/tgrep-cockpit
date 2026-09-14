# User Global Instructions for Codex (~/.codex/instructions.md)

## Codebase Search & Navigation Policy
When searching or exploring codebases:
1. **Fast Text / Symbol Search**: If `tgrep` is available on the machine, prefer `tgrep "<pattern>" .` for fast symbol and regex searches across repositories.
2. **AST Structural Search**: Use `ast-grep run -p '<pattern>'` when searching for language constructs (classes, decorators, interfaces, function signatures).
3. **Context Packing**: Use `repomix --include "<pattern>"` when dumping structured codebase context for high-context tasks.
4. **Fallback**: If `tgrep` is not applicable, fall back to standard `rg`.
