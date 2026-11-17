# Windows job-object holder for the orphan probe (strategy "job").
# Puts the target process and its current descendants into a new job with
# KILL_ON_JOB_CLOSE, waits for the target to exit, then terminates the job.
# Uses only PowerShell's Add-Type (C# compiled at run time); no shipped binary.
param([Parameter(Mandatory = $true)][int]$TargetPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ProbeJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }
  [StructLayout(LayoutKind.Sequential)]
  public struct EXTENDED { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr h, int c, ref EXTENDED i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr j, uint c);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    EXTENDED info = new EXTENDED();
    info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXTENDED))))
      throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
    return job;
  }
  public static int Assign(IntPtr job, int pid) {
    IntPtr p = OpenProcess(0x0100 | 0x0001 | 0x00100000, false, pid); // SET_QUOTA | TERMINATE | SYNCHRONIZE
    if (p == IntPtr.Zero) return Marshal.GetLastWin32Error();
    return AssignProcessToJobObject(job, p) ? 0 : Marshal.GetLastWin32Error();
  }
}
"@
$job = [ProbeJob]::Create()
$target = [ProbeJob]::OpenProcess(0x00100000, $false, $TargetPid)
$err = [ProbeJob]::Assign($job, $TargetPid)
"assign target $TargetPid -> $err"
# Descendants created before the assignment are not in the job yet; add them.
for ($round = 0; $round -lt 3; $round++) {
  $table = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate
  $known = @{ $TargetPid = ($table | Where-Object ProcessId -eq $TargetPid).CreationDate }
  do {
    $added = $false
    foreach ($p in $table) {
      if ($known.ContainsKey([int]$p.ProcessId) -or -not $known.ContainsKey([int]$p.ParentProcessId)) { continue }
      if ($p.CreationDate -lt $known[[int]$p.ParentProcessId]) { continue }
      $known[[int]$p.ProcessId] = $p.CreationDate; $added = $true
      $e = [ProbeJob]::Assign($job, [int]$p.ProcessId)
      if ($round -eq 0) { "assign descendant $($p.ProcessId) -> $e" }
    }
  } while ($added)
  Start-Sleep -Milliseconds 300
}
"ready"
[void][ProbeJob]::WaitForSingleObject($target, [uint32]::MaxValue)
"target exited; terminating job"
[void][ProbeJob]::TerminateJobObject($job, 1)
"done"
