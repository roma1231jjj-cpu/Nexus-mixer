# create_cert_user.ps1 - Create self-signed cert in user store (no admin needed)

try {
    $cert = New-SelfSignedCertificate -Subject "CN=NexusVAIO Test Certificate" -Type CodeSigning -CertStoreLocation "Cert:\CurrentUser\My" -KeyUsage DigitalSignature -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") -NotAfter (Get-Date).AddYears(10)
    Write-Host "OK Thumbprint: $($cert.Thumbprint)"
    exit 0
}
catch {
    Write-Host "User store failed: $_"
    
    try {
        # Try machine store read-only first - export existing
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("My", "LocalMachine")
        foreach ($c in $store) {
            if ($c.Subject -contains "NexusVAIO") {
                Write-Host "Found existing cert: $($c.Thumbprint)"
                exit 0
            }
        }
    } catch {}
    
    # Final fallback: write a PEM file manually for signtool
    Write-Host "Creating raw key+cert for signtool /f usage..."
    
    # Use certreq to generate key + cert
    $tmp = $env:TEMP
    $inf = "$tmp\NexusVAIO.inf"
    $csr = "$tmp\NexusVAIO.csr"
    $p12 = "$tmp\NexusVAIO.p12"
    
    # Create INF file for certreq
    Write-Host "Creating cert config..."
    
    # Use openssl online service fallback - just write a note
    Write-Host ""
    Write-Host "===== MANUAL STEPS ====="
    Write-Host "Run these commands from a browser or another machine with OpenSSL:"
    Write-Host ""
    Write-Host "openssl req -x509 -newkey rsa:2048 -keyout NexusVAIO.key -out NexusVAIO.crt -days 3650 -nodes -subj '/CN=NexusVAIO Test Certificate' -addext 'keyUsage=digitalSignature' -addext 'extendedKeyUsage=codeSigning'"
    Write-Host "openssl pkcs12 -export -out NexusVAIO.pfx -inkey NexusVAIO.key -in NexusVAIO.crt -passout pass:"
    Write-Host ""
    Write-Host "Then sign with:"
    Write-Host "signtool.exe sign /v /fd sha256 /f NexusVAIO.pfx "" E:\nexus-mixer\src-tauri\driver\build\x64\Release\nexusvaio.sys"""
    Write-Host ""
    
    # Try certreq
    Write-Host "Trying certreq..."
    & certreq -New -user -key "$p12" "$csr" 2>&1
    if (Test-Path $csr) {
        Write-Host "CSR created, signing self..."
        & certreq -Sign -user -binary -cert "$csr" 2>&1
    }
    
    exit 1
}