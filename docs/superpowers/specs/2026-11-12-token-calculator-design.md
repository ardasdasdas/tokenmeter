# Token Hesaplayıcı — Tasarım

## Amaç
Kullanıcı Hugging Face model adını (örn. `google/gemma-4-31B-it`) yapıştırır,
metin girer; araç metnin o modelin tokenizer'ında kaç token olduğunu gösterir.
Para cinsinden maliyet **hesaplanmaz** — yalnızca token sayısı.

## Hedefler
- Modelin gerçek `tokenizer.json` dosyasıyla birebir doğru sayım.
- `tokenizer.json` ilk istekte indirilip önbelleğe alınır (disk + bellek);
  sonraki isteklerde ağa çıkılmaz.
- Kilitli (gated) modeller için `HF_TOKEN` desteği; anahtar tarayıcıya gitmez.
- Logo/favicon ile kimliği olan tek sayfalık arayüz.

## Hedef dışı
- Fiyat/maliyet hesabı, sohbet şablonu (chat template) uygulama,
  `tokenizer.json` olmayan (yalnızca sentencepiece `tokenizer.model`) modeller.

## Yaklaşımlar
1. **Python + FastAPI + `tokenizers`** (seçilen): resmi Rust tabanlı kütüphane,
   doğru sonuç, anahtar sunucuda kalır. Kurulum gerektirir.
2. Statik sayfa + transformers.js: kurulumsuz, ama gated modeller için anahtar
   tarayıcıda; JS uyarlaması. Doğruluk ve güvenlik nedeniyle elendi.

## Ek: GitHub Pages (tarayıcı modu)
GitHub Pages statik olduğundan arayüz iki motorla çalışır: `api/cache` yanıt
veriyorsa yerel sunucu, vermiyorsa tarayıcı modu. Tarayıcı modu
`@huggingface/tokenizers@0.2.0` (jsDelivr) ile sayar, `tokenizer.json`'u Cache
Storage'da (`tokenmeter-v1`) tutar; kilitli modeller desteklenmez. İki modun
token ID'leri Qwen3-8B, Gemma 4 ve gpt-oss-20b üzerinde birebir aynı çıktı.
`?mode=browser` yerelde tarayıcı modunu zorlar. Site, `app/static` klasöründen
`.github/workflows/pages.yml` ile yayınlanır.

## Tasarım
- `app/main.py` — FastAPI: `GET /` arayüz, `POST /api/tokenize`
  `{model, text}` → `{model, token_count, char_count, tokens[], cached}`,
  `GET /api/cache` önbellekteki modeller, `DELETE /api/cache/{model}`.
- `app/tokenizer_cache.py` — `huggingface_hub.hf_hub_download` ile yalnızca
  `tokenizer.json` indirilir, `cache_dir=.cache/`; yüklenen `Tokenizer`
  nesneleri bellekte sözlükte tutulur. Hatalar: model yok (404), kilitli
  (401/403 → "HF_TOKEN gerekli / lisansı kabul et"), `tokenizer.json` yok.
- Özel tokenlar (BOS vb.) varsayılan olarak **eklenmez**; arayüzde
  "özel tokenları dahil et" seçeneği.
- Arayüz: model adı kutusu (HF URL'si yapıştırılırsa `owner/name` ayıklanır),
  metin alanı, yazdıkça (debounce) güncellenen token/karakter sayısı,
  renkli token görünümü, önbellekteki modeller çipleri.
