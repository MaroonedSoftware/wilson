using System.Runtime.InteropServices;

namespace MaroonedSoftware.Wilson.Desktop.Mac;

/// <summary>A rectangle as AppKit takes one by value.</summary>
[StructLayout(LayoutKind.Sequential)]
internal readonly record struct CGRect(double X, double Y, double Width, double Height);

/// <summary>
/// The Objective-C runtime, by its C interface, which is how this project reaches AppKit (`MacDockIcon`).
/// A signature here has to match what the method really takes, as nothing checks it.
/// </summary>
internal static partial class ObjC
{
    private const string Runtime = "/usr/lib/libobjc.dylib";

    /// <summary>A block's function pointer, past its `isa`, flags and reserved words.</summary>
    private const int BlockInvokeOffset = 16;

    private const int GlobalBlockFlag = 1 << 28;

    public static nint Class(string name)
    {
        var found = objc_getClass(name);
        return found != 0 ? found : throw new InvalidOperationException($"no Objective-C class {name}");
    }

    public static nint Sel(string name) => sel_registerName(name);

    public static bool Responds(nint receiver, string selector) => SendBool(receiver, Sel("respondsToSelector:"), Sel(selector));

    public static nint Autoreleased(string text) => Send(Class("NSString"), Sel("stringWithUTF8String:"), text);

    public static string? Text(nint nsString)
    {
        if (nsString == 0)
        {
            return null;
        }

        return Marshal.PtrToStringUTF8(Send(nsString, Sel("UTF8String")));
    }

    /// <summary>A new class of NSObject holding these methods, each of which must be `UnmanagedCallersOnly`.</summary>
    public static nint DefineClass(string name, IEnumerable<string> protocols, IEnumerable<(string Selector, nint Implementation, string Types)> methods)
    {
        var defined = objc_allocateClassPair(Class("NSObject"), name, 0);
        if (defined == 0)
        {
            throw new InvalidOperationException($"could not define {name}");
        }

        foreach (var protocol in protocols)
        {
            var found = objc_getProtocol(protocol);
            if (found != 0)
            {
                class_addProtocol(defined, found);
            }
        }

        foreach (var (selector, implementation, types) in methods)
        {
            class_addMethod(defined, Sel(selector), implementation, types);
        }

        objc_registerClassPair(defined);
        return defined;
    }

    /// <summary>A block whose function is given, which lives forever and captures nothing, so it can be built by hand.</summary>
    public static unsafe nint GlobalBlock(nint invoke)
    {
        var descriptor = (nint*)NativeMemory.AllocZeroed(2, (nuint)sizeof(nint));
        descriptor[1] = 4 * sizeof(nint);

        var block = (nint*)NativeMemory.AllocZeroed(4, (nuint)sizeof(nint));
        block[0] = NativeLibrary.GetExport(NativeLibrary.Load("/usr/lib/libSystem.B.dylib"), "_NSConcreteGlobalBlock");
        ((int*)block)[2] = GlobalBlockFlag;
        block[2] = invoke;
        block[3] = (nint)descriptor;
        return (nint)block;
    }

    /// <summary>Calls a block that takes one word, as a navigation's decision handler does.</summary>
    public static unsafe void InvokeBlock(nint block, nint argument)
    {
        var invoke = *(delegate* unmanaged<nint, nint, void>*)(block + BlockInvokeOffset);
        invoke(block, argument);
    }

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector, nint a);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend", StringMarshalling = StringMarshalling.Utf8)]
    public static partial nint Send(nint receiver, nint selector, string a);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector, nint a, nint b);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector, nint a, nint b, nint c);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector, nint a, nint b, nint c, nint d);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial nint Send(nint receiver, nint selector, CGRect a, nint b);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial nint SendScript(nint receiver, nint selector, nint source, nint injection, [MarshalAs(UnmanagedType.I1)] bool mainFrameOnly, nint world);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial void SendFlag(nint receiver, nint selector, [MarshalAs(UnmanagedType.I1)] bool value);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    public static partial void SendFeature(nint receiver, nint selector, [MarshalAs(UnmanagedType.I1)] bool enabled, nint feature);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    [return: MarshalAs(UnmanagedType.I1)]
    public static partial bool SendBool(nint receiver, nint selector);

    [LibraryImport(Runtime, EntryPoint = "objc_msgSend")]
    [return: MarshalAs(UnmanagedType.I1)]
    public static partial bool SendBool(nint receiver, nint selector, nint a);

    [LibraryImport(Runtime, EntryPoint = "objc_autoreleasePoolPush")]
    public static partial nint PoolPush();

    [LibraryImport(Runtime, EntryPoint = "objc_autoreleasePoolPop")]
    public static partial void PoolPop(nint pool);

    [LibraryImport(Runtime, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint objc_getClass(string name);

    [LibraryImport(Runtime, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint sel_registerName(string name);

    [LibraryImport(Runtime, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint objc_getProtocol(string name);

    [LibraryImport(Runtime, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint objc_allocateClassPair(nint superclass, string name, nint extraBytes);

    [LibraryImport(Runtime)]
    private static partial void objc_registerClassPair(nint defined);

    [LibraryImport(Runtime)]
    [return: MarshalAs(UnmanagedType.I1)]
    private static partial bool class_addProtocol(nint defined, nint protocol);

    [LibraryImport(Runtime, StringMarshalling = StringMarshalling.Utf8)]
    [return: MarshalAs(UnmanagedType.I1)]
    private static partial bool class_addMethod(nint defined, nint selector, nint implementation, string types);
}
