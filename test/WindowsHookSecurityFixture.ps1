param([Parameter(Mandatory = $true)][string]$FixturePath)

$ErrorActionPreference = 'Stop'
$fixtureAcl = Get-Acl -LiteralPath $FixturePath
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fixtureAcl.Sddl))
