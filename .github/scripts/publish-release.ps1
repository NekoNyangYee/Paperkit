param(
    [Parameter(Mandatory = $true)][string]$Commit,
    [string]$Root = (Join-Path $PSScriptRoot '../..'),
    [string]$AssetsPath = 'release-assets'
)

$ErrorActionPreference = 'Stop'
$version = (Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Invalid stable version.' }
if ($Commit -notmatch '^[0-9a-f]{40}$') { throw 'Invalid release commit.' }
if ($env:GH_REPO -notmatch '^[\w-]+/[\w.-]+$') { throw 'Invalid release repository.' }
$tag = "v$version"

function Get-GitHubObject([string]$Endpoint) {
    $result = gh api $Endpoint 2>$null
    $status = $LASTEXITCODE
    $body = ($result -join "`n") | ConvertFrom-Json
    if ($status -eq 0) { return $body }
    if ($body.status -eq 404) { return $null }
    throw "GitHub lookup failed: $Endpoint"
}

$existing = Get-GitHubObject "repos/$env:GH_REPO/releases/tags/$tag"
if ($null -ne $existing) {
    if ($existing.draft) { throw "An existing draft for $tag needs review before publication." }
    Write-Host "$tag is already published. Skipping release; existing assets are unchanged."
    exit 0
}

$tagRef = Get-GitHubObject "repos/$env:GH_REPO/git/ref/tags/$tag"
if ($null -ne $tagRef) {
    $tagCommit = Get-GitHubObject "repos/$env:GH_REPO/commits/$tag"
    if ($null -eq $tagCommit -or $tagCommit.sha -ne $Commit) {
        throw "$tag points to a different commit; refusing to publish unrelated assets."
    }
}
$installer = Join-Path $AssetsPath "Paperkit_${version}_x64-setup.exe"
$checksums = Join-Path $AssetsPath 'SHA256SUMS.txt'
if (!(Test-Path -LiteralPath $installer) -or !(Test-Path -LiteralPath $checksums)) { throw 'Installer or checksum is missing.' }
if (@(Get-ChildItem -LiteralPath $AssetsPath -File).Count -ne 2) { throw 'Unexpected release assets.' }
$expected = "{0}  {1}" -f (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $installer -Leaf)
if ((Get-Content -LiteralPath $checksums -Raw).Trim() -ne $expected) { throw 'Installer checksum mismatch.' }
$notes = Join-Path $Root ".github/releases/$tag.md"
if (!(Test-Path -LiteralPath $notes)) { throw "Release notes missing: $notes" }

# Create the version tag at the commit that produced these verified artifacts.
gh release create $tag $installer $checksums --target $Commit --draft --title "Paperkit $tag" --notes-file $notes
if ($LASTEXITCODE -ne 0) { throw 'Could not create release.' }
gh release edit $tag --draft=false --latest
if ($LASTEXITCODE -ne 0) { throw 'Could not publish release.' }
