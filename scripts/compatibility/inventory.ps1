$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$destination = Join-Path $projectRoot 'artifacts/compatibility'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$tools = @()
foreach ($name in 'git','node','npm','python','code','codex','opencode','arduino-cli','kicad-cli','FreeCAD','wsl') {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
        $version = if ($name -eq 'wsl') { 'present; WSL workaround not selected or probed' } else { (& $command.Source --version 2>&1 | Out-String).Trim() }
        $tools += [ordered]@{ tool = $name; executablePath = $command.Source; observedVersion = $version; compatibility = 'unverified' }
    } else { $tools += [ordered]@{ tool = $name; executablePath = $null; observedVersion = $null; compatibility = 'not-found-on-PATH' } }
}
$arduino = Join-Path $env:ProgramFiles 'Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'
if (Test-Path -LiteralPath $arduino) {
    $tools += [ordered]@{ tool = 'arduino-cli (IDE bundled)'; executablePath = $arduino; observedVersion = (& $arduino version | Out-String).Trim(); compatibility = 'unverified' }
    & $arduino config dump --json | Set-Content -LiteralPath (Join-Path $destination 'arduino-config.json') -Encoding utf8
    $cores = & $arduino core list --json | ConvertFrom-Json
    $cores.platforms | ForEach-Object { [ordered]@{ id = $_.id; installedVersion = $_.installed_version } } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $destination 'arduino-cores.json') -Encoding utf8
}
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor
$computer = Get-CimInstance Win32_ComputerSystem
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($projectRoot).Substring(0,1))
$record = [ordered]@{
    validatedAt = [DateTime]::UtcNow.ToString('o')
    os = [ordered]@{ caption = $os.Caption; version = $os.Version; architecture = $os.OSArchitecture }
    cpu = $cpu.Name; totalPhysicalMemoryBytes = $computer.TotalPhysicalMemory; projectDriveFreeBytes = $drive.Free
    tools = $tools
    limitations = @('No serial enumeration/open/reset/upload performed.', 'No provider credential files read.', 'Tool presence and version alone are not compatibility passes.', 'No WSL, CAD or EDA support claimed.')
}
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $destination 'environment.json') -Encoding utf8
Write-Output "Inventory written to artifacts/compatibility/environment.json"
