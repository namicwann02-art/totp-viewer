# TOTP Viewer — Telegram Mini App

Google Authenticator hesaplarınız için tarayıcıda çalışan, sunucusuz bir 2FA kod görüntüleyici.

## Nasıl çalışır
- Tüm QR decode ve TOTP hesaplama işlemleri tarayıcınızda (JavaScript ile) yapılır.
- Secret'lar yalnızca bu sayfayı açtığınız cihazın `localStorage`'ında tutulur; hiçbir sunucuya gönderilmez.
- Google Authenticator'daki "Hesapları Aktar" QR kodunun ekran görüntüsünü yükleyerek hesapları içe aktarırsınız.

## Kurulum (GitHub Pages)
1. Bu klasördeki dosyaları bir GitHub reposuna yükleyin (repo **Public** olmalı).
2. Repo **Settings → Pages** → Source: "Deploy from a branch", Branch: `main` / `(root)`.
3. Birkaç dakika içinde `https://<kullanıcı-adı>.github.io/<repo-adı>/` adresinde yayında olur.

## Telegram'a bağlama
1. **@BotFather** → `/mybots` → botunuzu seçin → **Bot Settings → Menu Button**.
2. Yukarıdaki GitHub Pages URL'ini gönderin, ardından bir buton etiketi (örn. "2FA Codes") girin.
3. Bot sohbetinizi açın, menü butonuna dokunarak mini app'i test edin.

Bot için ayrıca çalışan bir sunucu/backend gerekmez — sayfa tamamen statiktir.

## Güvenlik notu
`localStorage` şifrelenmemiştir; bu cihaza fiziksel/tarayıcı erişimi olan biri secret'ları okuyabilir
(kayıtlı tarayıcı şifreleriyle aynı risk sınıfı). Google Authenticator'ı kaldırmayın — bu araç
sadece ek bir görüntüleyicidir, tek kopya olarak kullanılmamalıdır.
