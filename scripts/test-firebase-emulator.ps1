$ErrorActionPreference = "Stop"

$jdkPath = $null
$javaExecutable = $null
$preferredJdkPath = "C:\Program Files\Java\jdk-21"

if (Test-Path -LiteralPath "$preferredJdkPath\bin\java.exe") {
  $jdkPath = $preferredJdkPath
  $javaExecutable = "$jdkPath\bin\java.exe"
} elseif ($env:JAVA_HOME -and (Test-Path -LiteralPath "$env:JAVA_HOME\bin\java.exe")) {
  $jdkPath = $env:JAVA_HOME
  $javaExecutable = "$jdkPath\bin\java.exe"
} else {
  $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue
  if ($javaCommand) {
    $javaExecutable = $javaCommand.Source
    $jdkPath = Split-Path -Parent (Split-Path -Parent $javaExecutable)
  }
}

if (-not $javaExecutable) {
  throw "Firebase Emulator requires JDK 21. Set JAVA_HOME or add java.exe to PATH."
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$javaVersion = (& $javaExecutable -version 2>&1 | Select-Object -First 1) -join ""
$ErrorActionPreference = $previousErrorActionPreference
if ($javaVersion -notmatch 'version "21(?:\.|\")') {
  throw "Firebase Emulator requires JDK 21, but found: $javaVersion"
}

$env:JAVA_HOME = $jdkPath
$env:PATH = "$jdkPath\bin;$env:PATH"
& "$PSScriptRoot\..\node_modules\.bin\firebase.cmd" emulators:exec `
  --project demo-noteproject-stage9 `
  --only firestore,storage `
  "vitest run --config vitest.firebase.config.ts"
exit $LASTEXITCODE
