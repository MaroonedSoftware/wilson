# Wilson for macOS

The operator's board as a native app for Apple Silicon Macs, in .NET 10 and Avalonia. `CLAUDE.md` has
what you need to change it safely.

```bash
cd apps/desktop
dotnet build -warnaserror
dotnet test --solution Wilson.Desktop.slnx
dotnet run --project src/MaroonedSoftware.Wilson.Desktop
tools/macos/make-app-bundle.sh
```

On first run, give it the address of your Wilson server, such as `tower:13101`, and sign in. A session
is kept in the Keychain. An account whose only second factor is a passkey cannot sign in here: add an
authenticator in the web app.
