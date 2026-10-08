# Contributing

Thanks for taking a look. This is a single-tenant app (one admin account on your
own Cloudflare account), so most contributions are provider fixes, UI work, or
tests.

Local setup, the checks that must pass, and what the code expects all live in
[docs/development.md](docs/development.md) — one place, so they cannot drift
apart.

## Pull requests

- One logical change per PR, conventional-commit title (`fix(threads): …`, `feat(editor): …`).
- Say what you changed and why in the body; include the failing case you fixed when there is one.
- Update the docs when behavior or configuration changes — the README for anything a user sees first, or the matching page under `docs/`. Those pages are also published at [cogsend.com/docs](https://cogsend.com/docs/): a new page needs an entry in the [website repo](https://github.com/cogsend/website)'s `src/docs/nav.mjs`, and a few headings are pinned by it (listed in [AGENTS.md](AGENTS.md)).
- Provider changes: mention which platform you tested against and with what account type.

## Security

Please do not open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your work is licensed under the [MIT License](LICENSE).
