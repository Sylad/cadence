# changelog.d — the entries of the next release

Each lot writes its CHANGELOG entry here, in its own file `changelog.d/<lot>.md` (`L679.md`), never under
`## [Unreleased]` of `CHANGELOG.md`: two branches that each add a file never conflict (L679).

A fragment is one or more Keep a Changelog sections, each a `###` title then its entries:

```markdown
### Fixed

- What changes for the user (L679, [docs/releasing.md](docs/releasing.md)): …
```

Titles: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. A review fix of the same lot edits the lot's
fragment; if a release already removed it, recreate it with only the fix's entry (the earlier one is published).
`cadence release patch|minor|major` gathers the fragments into the section of the version (sections grouped in that
order, the most recent lot first within a section) and removes them in the version commit; this file stays.
See [docs/releasing.md](../docs/releasing.md#changelog-fragments).
