using System.Runtime.InteropServices;

namespace PiDesktop.Services;

/// <summary>
/// pi-agent (Rust) C-ABI 原生库「pi_agent.dll」的 P/Invoke 绑定。
/// 所有返回的字符串由 Rust 侧分配，必须用 <c>pi_string_free</c> 释放——
/// <see cref="TakeString"/> 已封装「读取 + 释放」。
/// </summary>
internal static partial class NativeMethods
{
    private const string Dll = "pi_agent";

    [LibraryImport(Dll)]
    internal static partial IntPtr pi_agent_version();

    [LibraryImport(Dll)]
    internal static partial IntPtr pi_agent_create();

    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial IntPtr pi_agent_create_json(string configJsonUtf8);

    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial IntPtr pi_config_check(string configJsonUtf8);

    [LibraryImport(Dll)]
    internal static partial void pi_agent_destroy(IntPtr handle);

    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial IntPtr pi_agent_send(IntPtr handle, string inputUtf8);

    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial IntPtr pi_agent_send_with_bridge(IntPtr agentHandle, IntPtr bridgeHandle, string inputUtf8);

    [LibraryImport(Dll)]
    internal static partial IntPtr pi_components_json();

    [LibraryImport(Dll)]
    internal static partial IntPtr pi_components_status_json();

    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial IntPtr pi_component_action_start(string componentIdUtf8, string actionUtf8);

    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial IntPtr pi_ffmpeg_job_start(string requestJsonUtf8);

    [LibraryImport(Dll)]
    internal static partial IntPtr pi_job_status_json(IntPtr job);

    [LibraryImport(Dll)]
    internal static partial void pi_job_cancel(IntPtr job);

    [LibraryImport(Dll)]
    internal static partial void pi_job_destroy(IntPtr job);

    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial IntPtr pi_bridge_connect(string bridgeRepoDirUtf8);

    [LibraryImport(Dll, StringMarshalling = StringMarshalling.Utf8)]
    internal static partial IntPtr pi_bridge_call(IntPtr handle, string toolUtf8, string argsJsonUtf8);

    [LibraryImport(Dll)]
    internal static partial void pi_bridge_destroy(IntPtr handle);

    [LibraryImport(Dll)]
    internal static partial void pi_string_free(IntPtr s);

    /// <summary>把 Rust 返回的 char* 读成 string 并释放它。</summary>
    internal static string TakeString(IntPtr ptr)
    {
        if (ptr == IntPtr.Zero) return string.Empty;
        try { return Marshal.PtrToStringUTF8(ptr) ?? string.Empty; }
        finally { pi_string_free(ptr); }
    }
}
