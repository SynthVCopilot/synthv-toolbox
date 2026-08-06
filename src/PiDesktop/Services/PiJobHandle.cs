using Microsoft.Win32.SafeHandles;

namespace PiDesktop.Services;

/// <summary>Owns one native <c>PiJob*</c> and destroys it exactly once.</summary>
internal sealed class PiJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    internal PiJobHandle() : base(ownsHandle: true) { }

    internal PiJobHandle(IntPtr handle) : base(ownsHandle: true) => SetHandle(handle);

    protected override bool ReleaseHandle()
    {
        NativeMethods.pi_job_destroy(handle);
        return true;
    }
}
