# User Global Instructions for Claude Code (~/.claude/CLAUDE.md)

## Codebase Search & Navigation Policy
When searching codebases on this machine:
1. **Text & Regex Search**: If a repository has a `.tgrep` directory or if `tgrep` is available, prefer `tgrep "<pattern>" .` over standard `ripgrep`/`grep`. It uses an inverted trigram index and returns in <10ms.
2. **Structural / AST Search**: Prefer `ast-grep run -p '<pattern>'` when searching for syntactic code structures (functions, classes, decorators, interface definitions, call patterns).
3. **Context Packing**: When packing whole modules or inspecting overall file token distributions, use `repomix --include "<path>/**"`.
4. **Fallback**: If `tgrep` or `ast-grep` are unavailable in a particular context, fall back to standard `ripgrep` (`rg`).
