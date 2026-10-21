# Quy tắc làm việc với repo này

Chủ repo (Mondiro) là artist, không phải lập trình viên. Trả lời bằng tiếng Việt, giải thích dễ hiểu.

## Phiên bản và phát hành

- Sửa xong thì **tự nâng `version` trong `package.json`** và **tự viết `release-notes.md`** (Mondiro đã cho phép,
  không cần hỏi). Sửa lỗi nhỏ: tăng số cuối (1.0.0 → 1.0.1). Thêm tính năng: tăng số giữa (1.0.1 → 1.1.0).
- `release-notes.md`: dòng đầu `# v<version>` trùng với `package.json`, bên dưới là các dòng ngắn bằng tiếng Việt
  mô tả thay đổi người dùng thấy được. Nội dung này hiện trong bảng cập nhật của app và trên trang Release.
- Push lên nhánh mặc định của repo là GitHub Actions tự build `MondiroFormaLab-<version>-setup.exe` và phát hành,
  app đã cài sẽ tự cập nhật.

## Key

- Khoá app **dùng chung key với Spine Preview và Mondiro Toolbox**: danh sách nằm ở `access/keys.json` trong repo
  `satthupc00/Spine_Preview`. Không tạo danh sách key riêng. Không đổi tiền tố `SPV-` và chuỗi muối băm
  `spine-preview:` trong `license.js`.

## Bí mật

- Không ghi phím tắt mở bảng Admin vào bất kỳ file công khai nào (README, release notes, commit message, mô tả PR).
  Repo để Public.

## Code

- Giao diện: `renderer/index.html`, `renderer/styles.css`. Logic 3D và panel: `src/*.js`, được gộp thành
  `renderer/app.js` bằng `npm run build` (file này không commit).
- Chuẩn giao diện theo m-skill (header Mondiro, "Created by Mondiro", nút kiểm tra cập nhật, chữ `latest` xanh).
- Model mẫu MonBot sinh bằng `python3 tools/make-sample-monbot.py`.
