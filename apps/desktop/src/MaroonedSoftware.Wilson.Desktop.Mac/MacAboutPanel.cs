using System.Runtime.InteropServices;

namespace MaroonedSoftware.Wilson.Desktop.Mac;

/// <summary>
/// The standard macOS About panel, which reads its name, icon and version from the bundle's Info.plist.
/// </summary>
/// <remarks>
/// Run from `dotnet run` there is no bundle, so it shows the process name and no version.
/// </remarks>
public static partial class MacAboutPanel
{
    private const string ObjC = "/usr/lib/libobjc.dylib";

    /// <summary>Opens the panel. Call on the UI thread, as AppKit requires.</summary>
    public static void Show()
    {
        var application = objc_msgSend(objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
        objc_msgSend(application, sel_registerName("orderFrontStandardAboutPanel:"), nint.Zero);
    }

    [LibraryImport(ObjC, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint objc_getClass(string name);

    [LibraryImport(ObjC, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint sel_registerName(string name);

    [LibraryImport(ObjC)]
    private static partial nint objc_msgSend(nint receiver, nint selector);

    [LibraryImport(ObjC)]
    private static partial nint objc_msgSend(nint receiver, nint selector, nint argument);
}
