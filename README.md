# Chatbot CrossCheck

Extension Chrome (MV3) chuyển đầu ra qua lại giữa ChatGPT và Claude để double check.

## Cài đặt
1. Mở `chrome://extensions`, bật **Developer mode**.
2. **Load unpacked** → chọn thư mục `chatbot-crosscheck`.
3. **Tải lại (F5) các tab ChatGPT và Claude đang mở** để content script được nạp.

## Cách dùng
1. Trao đổi ở một trong hai chatbot, chờ trả lời xong.
2. Mở side panel (bấm icon extension). Ở tab ChatGPT bấm "Gán tab này" dòng ChatGPT; sang tab Claude bấm dòng Claude (nếu mỗi bên chỉ có 1 tab thì tự nhận).
3. Chọn **bên nguồn** = tab có câu trả lời mới nhất:
   - **▶ Từ ChatGPT → Claude**: lấy câu trả lời cuối của ChatGPT gửi sang Claude, rồi luân phiên.
   - **▶ Từ Claude → ChatGPT**: ngược lại.
4. **⏸ Tạm dừng** bất kỳ lúc nào, tự nhắn thêm ở các tab, rồi chọn lại bên nguồn để chạy tiếp. Ô "Ghi chú của tôi" được chèn vào đúng một lượt chuyển kế tiếp.

N = số lần bên kết thúc (mặc định ChatGPT) trả lời thêm. Bắt đầu từ ChatGPT: 2N lần chuyển; bắt đầu từ Claude: 2N−1 lần chuyển — cả hai đều kết thúc ở bên đã chọn.

## Tín hiệu "đã trả lời xong"
Thanh action cuối tin nhắn (copy / read aloud / like / dislike / retry) xuất hiện, tin nhắn không còn ở trạng thái streaming, và text ổn định thêm ~1.2s. Chỉ chấp nhận tin nhắn có ID KHÁC với ID lượt cuối trước khi gửi, nên không bao giờ lấy nhầm lượt cũ.

## Khi site đổi giao diện
Mọi selector nằm trong `CFG` ở đầu `content.js`. Các điểm cần soát đầu tiên: `messages`, `doneBar`, `composer`, `send`.

## Lưu ý
- Paste văn bản dài có thể bị site tự đổi thành file đính kèm — vẫn gửi được, extension chờ nút Gửi sáng lên.
- Tab chạy nền có thể bị Chrome throttle; nên đặt hai tab ở hai cửa sổ cạnh nhau, không để cửa sổ bị che hoàn toàn.
- Nội dung được đọc/chuyển dạng Markdown (giữ code block, bảng, công thức LaTeX).
