namespace MaroonedSoftware.Wilson.Desktop.Core.Settings;

/// <summary>How the app is drawn. System follows macOS, as the web app's `auto` follows the browser.</summary>
public enum Appearance
{
    System,
    Light,
    Dark,
}

/// <summary>The header's control steps through these, so each is one press from the last.</summary>
public static class Appearances
{
    public static Appearance Next(Appearance appearance) =>
        appearance switch
        {
            Appearance.System => Appearance.Light,
            Appearance.Light => Appearance.Dark,
            _ => Appearance.System,
        };
}
