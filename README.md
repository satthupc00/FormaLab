# Mondiro FormaLab

App Windows để xem model 3D: **FBX, GLB/glTF, OBJ** với material **PBR**, đèn, **HDRI**, **animation**,
và xuất ảnh / video turntable đúng khung hình.

## Cài đặt

Tải `MondiroFormaLab-<version>-setup.exe` ở mục **Releases** của repo, cài một lần, mở app và nhập key
(dùng chung key `SPV-...` với Spine Preview / Mondiro Toolbox). Từ đó về sau app tự cập nhật.

## Tính năng

- **Mở model**: nút *Mở model* (Ctrl+O) hoặc kéo thả file vào cửa sổ. Texture nằm cạnh model hoặc trong thư mục
  `textures/` được tự tìm và tự gán.
- **Điều khiển camera**: xoay bằng chuột trái · pan bằng chuột giữa, chuột phải hoặc Shift + chuột trái · zoom bằng lăn
  chuột · **F** hoặc nhấp đúp để căn camera vào model.
- **Material PBR**: Base Color, Normal, ORM (gộp), Roughness, Metallic, AO, Emissive, Opacity, Height.
  Thả cả thư mục texture vào là tự gán theo tên (`_BaseColor`, `_Albedo`, `_Normal`, `_ORM`, `_Roughness`,
  `_Metallic`, `_AO`, `_Emissive`, `_Opacity`, `_Height`… kiểu Substance / Unreal / Unity). Thả 1 ảnh vào ô để gán riêng.
  Có tuỳ chọn Normal map DirectX, chỉnh roughness / metallic / độ mạnh normal / phát sáng.
- **Ánh sáng**: đèn Directional / Point / Spot (thêm, xoá, ẩn, màu, cường độ, hướng, độ cao), đổ bóng, tone map
  (ACES, AgX, Neutral), exposure.
- **Môi trường**: 6 HDRI có sẵn, nạp file `.hdr` / `.exr`, xoay HDRI, độ sáng, làm mờ nền, hoặc tắt HDRI dùng màu nền.
- **Animation**: chọn clip, play / pause (Space), tua từng frame (← →), tốc độ, lặp. Nút *Thêm animation* nạp animation
  từ file FBX / GLB khác cùng bộ xương (khớp tên xương, bỏ qua tiền tố kiểu `mixamorig:`). File đặt tên
  `TenModel@Run.fbx` hoặc `TenModel_Anim_Run.fbx` cạnh model được nạp tự động.
- **Chế độ xem**: Shaded, Wireframe, UV checker, Matcap, xem riêng từng kênh texture, hiện xương, lưới sàn.
- **Xuất ảnh**: gõ độ phân giải, bật *Safe frame* để thấy khung vùng render trên viewport; PNG (có thể nền trong suốt)
  hoặc JPG, khử răng cưa 4×. **Video turntable 360°** (MP4) đúng khung safe frame.
- Model bị nằm ngửa (xuất từ phần mềm Z-up) thì tick *Model bị nằm (trục Z-up)*.

## Model mẫu để thử

Trong app bấm **Mở model mẫu** (hoặc icon hộp cạnh nút *Mở model*). Các file nằm trong thư mục `samples/`:

| File | Nội dung |
|---|---|
| `samples/MonBot/MonBot.fbx` | Robot có 17 xương, animation *Idle*, texture PBR trong `textures/` (BaseColor, Normal, ORM, Emissive) |
| `samples/MonBot/animations/MonBot_Anim_Walk.fbx`, `MonBot_Anim_Wave.fbx` | Chỉ có xương + animation, dùng để thử nút *Thêm animation* |
| `samples/DamagedHelmet.glb` | Mũ sci-fi PBR đầy đủ kênh (glTF) |
| `samples/Fox.glb` | Con cáo low-poly có 3 animation (glTF) |

Bản đã cài: thư mục mẫu nằm ở `C:\Users\<tên>\AppData\Local\Programs\Mondiro FormaLab\resources\samples`.

Nguồn và giấy phép: MonBot do FormaLab tự tạo (`tools/make-sample-monbot.py`). DamagedHelmet và Fox lấy từ
[Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets): DamagedHelmet – CC BY 4.0
(theblueturtle_), Fox – CC0 (PixelMannen) + CC BY 4.0 (rigging: tomkranis, chuyển glTF: @AsoboStudio, @scurest).
HDRI trong `hdri/` từ [Poly Haven](https://polyhaven.com) – CC0.

## Chạy thử từ source (dev)

1. Cài [Node.js](https://nodejs.org) bản LTS.
2. Mở PowerShell tại thư mục này:
   ```
   npm install
   npm start
   ```

## Đóng gói thử trên máy mình

```
npm run dist          # build file Setup .exe vào thư mục dist/
```

## Phát hành bản mới (tự động cập nhật)

Đổi `"version"` trong `package.json` và viết dòng `# v<version>` + nội dung mới trong `release-notes.md`, rồi push lên
nhánh mặc định. GitHub Actions tự build `MondiroFormaLab-<version>-setup.exe` và đăng lên **Releases** (khoảng 5–10 phút,
xem ở tab **Actions**). App đã cài kiểm tra bản mới lúc mở và mỗi 1 tiếng (hoặc khi bấm icon **mũi tên xoay** góc phải
trên), tự tải về rồi hiện bảng cập nhật kèm ghi chú. Khi đã là bản mới nhất, chữ **latest** màu xanh hiện cạnh tên app.

## Cấu trúc

```
main.js            — cửa sổ Electron, hộp thoại mở / lưu file
license.js         — kiểm tra key (danh sách chung với Spine Preview)
updater.js         — tự cập nhật từ GitHub Releases
renderer/          — giao diện (index.html, styles.css, license-ui.js = màn hình key + bảng cập nhật)
src/               — viewer 3D (three.js), đọc model, material PBR, panel → gộp thành renderer/app.js
samples/, hdri/    — model mẫu và HDRI đi kèm app
tools/             — script tạo model mẫu MonBot
build/             — icon app (icon.svg, icon-small.svg cho cỡ nhỏ, icon.png, icon.ico)
```
