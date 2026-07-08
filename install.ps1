# Valyu CLI installer for Windows
# Usage: irm https://get.valyu.ai/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = "valyuAI/valyu-cli"
$InstallDir = if ($env:VALYU_INSTALL_DIR) { $env:VALYU_INSTALL_DIR } else { "$env:USERPROFILE\.valyu\bin" }
$BinaryName = "valyu.exe"

Write-Host "Fetching latest release..."

$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
$Tag = $Release.tag_name
$Asset = "valyu-windows-x64.zip"
$DownloadUrl = "https://github.com/$Repo/releases/download/$Tag/$Asset"

Write-Host "Installing Valyu CLI $Tag..."

# Create install directory
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Download and extract
$TmpDir = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
$ZipPath = Join-Path $TmpDir $Asset

Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force
Move-Item -Force (Join-Path $TmpDir $BinaryName) (Join-Path $InstallDir $BinaryName)

# Clean up
Remove-Item -Recurse -Force $TmpDir

Write-Host ""
Write-Host "Valyu CLI $Tag installed to $InstallDir\$BinaryName"

# Add to PATH if needed
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$CurrentPath", "User")
    Write-Host "Added $InstallDir to your PATH. Restart your terminal to use 'valyu'."
} else {
    Write-Host "Run 'valyu --help' to get started."
}
