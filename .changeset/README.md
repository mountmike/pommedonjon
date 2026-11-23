# Changesets

Every change that should appear in a release adds a file here:

```bash
pnpm changeset
```

Pick the bump (patch, minor or major) and write one or two sentences for the
changelog, in terms of what someone running the app will notice. Commit the
file with the change.

Nothing is released by adding a changeset. Releases happen when the "Version
Packages" pull request, which collects them, is merged. See "Releasing" in
the README.
