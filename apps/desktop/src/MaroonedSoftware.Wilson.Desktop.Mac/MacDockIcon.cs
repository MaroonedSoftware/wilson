using System.Runtime.InteropServices;

namespace MaroonedSoftware.Wilson.Desktop.Mac;

/// <summary>
/// Whether the app has a Dock icon, which macOS ties to the application's activation policy.
/// </summary>
/// <remarks>
/// Without one the app also has no application menu and is not in the Cmd+Tab list, so this goes with the
/// window being hidden rather than with anything the user can still reach.
/// </remarks>
public static partial class MacDockIcon
{
    private const string ObjC = "/usr/lib/libobjc.dylib";
    private const nint PolicyRegular = 0;
    private const nint PolicyAccessory = 1;

    /// <summary>Puts the icon back. Call on the UI thread, as AppKit requires, and before showing a window.</summary>
    public static void Show() => SetActivationPolicy(PolicyRegular);

    /// <summary>Takes the icon away. Call on the UI thread, as AppKit requires.</summary>
    public static void Hide() => SetActivationPolicy(PolicyAccessory);

    private static void SetActivationPolicy(nint policy)
    {
        var application = objc_msgSend(objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
        objc_msgSend(application, sel_registerName("setActivationPolicy:"), policy);
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
