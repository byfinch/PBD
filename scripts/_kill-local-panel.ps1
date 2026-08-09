Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dist/index.js web*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
exit 0
