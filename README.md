# Storekeeper

Stock, bulk sales and staff app for the warehouse. It runs in a web browser, installs on a phone, and has a Windows app for the warehouse computer.

- **Setting it up:** see [SETUP.md](SETUP.md).
- **Making changes with Claude Code:** [CLAUDE.md](CLAUDE.md) has the notes Claude reads before working on the project.

Folders:

- `app/`: the website that Netlify publishes.
- `desktop/`: the Windows app, which shows the website and prints receipts through the Windows printer driver.
- `supabase-setup.sql`: the database (run it in Supabase's SQL Editor).
- `tests/`: automatic checks.
