$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
$groups = @{}
foreach ($p in $procs) {
  $dir = "(diger)"
  if ($p.CommandLine -match '--user-data-dir="?([^ "]+)') { $dir = $Matches[1] }
  if (-not $groups.ContainsKey($dir)) { $groups[$dir] = 0 }
  $groups[$dir]++
}
$groups.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { "{0,4}  {1}" -f $_.Value, $_.Key }
