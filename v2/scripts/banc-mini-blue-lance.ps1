# Lanceur détaché de banc-mini-blue.sh (L901), comme mini-blue-lance.ps1 : Start-Process meurt avec la session ssh,
# Win32_Process.Create sort le wsl.exe de son objet job ; le banc vit tant que le script WSL tourne.
param([string]$Distro, [string]$Script, [string]$Job)
$cmd = "wsl.exe -d $Distro -- bash $Script lance $Job"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($r.ReturnValue -ne 0) { "banc-mini-blue-lance : echec Win32_Process.Create ($($r.ReturnValue))"; exit 1 }
"banc-mini-blue-lance : wsl.exe pid Windows $($r.ProcessId)"
