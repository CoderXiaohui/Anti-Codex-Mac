# Reads and writes the Windows AppUserModelID stored on a .lnk shortcut.
# The patched host calls setAppUserModelId("AC"). When no Start Menu shortcut carries that ID,
# Windows notifications create their own root Start Menu shortcut that starts Anti-Codex.exe
# directly and skips the managed launcher. Tagging the managed Start Menu shortcut prevents that.

$script:AntiCodexAppUserModelId = "AC"

if (-not ("AntiCodexShortcutAppId" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class AntiCodexShortcutAppId {
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount(out uint count);
        int GetAt(uint index, out PropertyKey key);
        int GetValue(ref PropertyKey key, [Out] PropVariant value);
        int SetValue(ref PropertyKey key, [In] PropVariant value);
        int Commit();
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid FormatId; public uint PropertyId; }
    [StructLayout(LayoutKind.Sequential)]
    sealed class PropVariant : IDisposable {
        ushort valueType; ushort reserved1; ushort reserved2; ushort reserved3; IntPtr pointerValue; IntPtr padding;
        public PropVariant() { }
        public PropVariant(string text) { valueType = 31; pointerValue = Marshal.StringToCoTaskMemUni(text); }
        public string Text { get { return valueType == 31 ? Marshal.PtrToStringUni(pointerValue) : null; } }
        public void Dispose() { PropVariantClear(this); }
        [DllImport("ole32.dll")] static extern int PropVariantClear([In, Out] PropVariant value);
    }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
    static PropertyKey AppUserModelIdKey() {
        return new PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), PropertyId = 5 };
    }
    static T Open<T>(string path, int mode, out object link) where T : class {
        link = new ShellLink();
        ((IPersistFile)link).Load(path, mode);
        return (T)link;
    }
    public static string Get(string path) {
        object link;
        var store = Open<IPropertyStore>(path, 0, out link);
        var key = AppUserModelIdKey();
        using (var value = new PropVariant()) {
            Marshal.ThrowExceptionForHR(store.GetValue(ref key, value));
            return value.Text ?? "";
        }
    }
    public static void Set(string path, string appUserModelId) {
        object link;
        var store = Open<IPropertyStore>(path, 2, out link);
        var key = AppUserModelIdKey();
        using (var value = new PropVariant(appUserModelId)) {
            Marshal.ThrowExceptionForHR(store.SetValue(ref key, value));
        }
        Marshal.ThrowExceptionForHR(store.Commit());
        ((IPersistFile)link).Save(path, true);
    }
}
'@
}

function Get-AntiCodexShortcutAppUserModelId {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [AntiCodexShortcutAppId]::Get($Path)
}

function Set-AntiCodexShortcutAppUserModelId {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AppUserModelId
    )
    [AntiCodexShortcutAppId]::Set($Path, $AppUserModelId)
}