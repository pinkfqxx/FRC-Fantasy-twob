---
name: /help maintenance
description: Rule for keeping /help in sync whenever commands or features are added or changed.
---

# /help maintenance

## Rule
Whenever a slash command is added, renamed, removed, or a significant user-facing feature changes, update **all three** of:

1. `commands.js` — add/edit the `SlashCommandBuilder` entry
2. `HELP_CATEGORIES` in `index.js` — add a line to the relevant category's `lines[]` array (search for `const HELP_CATEGORIES`)
3. The command table in `replit.md` — keep the project README accurate

Then run `node commands.js` so Discord picks up the change (global commands propagate within ~1 hour).

**Why:** `/help` is the only in-Discord reference players have. A command that exists but isn't listed there is effectively invisible. The comment block above `HELP_CATEGORIES` in `index.js` also states this rule for anyone reading the code directly.

**How to apply:** Before closing any task that touches commands or user-facing behavior, grep for `HELP_CATEGORIES` in `index.js` and verify the new thing appears there.
