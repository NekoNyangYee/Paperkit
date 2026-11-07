$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repo
try {
    New-Item -ItemType Directory -Path '.cache' -Force | Out-Null
    $bundle = Join-Path $repo '.cache/paperkit-backend.tar.gz'
    # Explicit allowlist: excludes .env, local DBs, documents and build caches.
    & tar -czf $bundle Cargo.toml Cargo.lock Dockerfile compose.yaml .dockerignore .env.example apps/backend/Cargo.toml apps/backend/src apps/backend/migrations apps/backend/tests deploy apps/desktop/src-tauri/Cargo.toml crates/pdf-core/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
    Write-Output "Created $bundle"
} finally {
    Pop-Location
}
