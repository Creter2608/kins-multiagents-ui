# Đặc tả Kiến trúc Autonomous Multi-Agent Loop v3.0 (Mô hình 5 Giai đoạn)

**Phiên bản:** 3.0.0-Draft  
**Ngày lập:** 2026-09-09  
**Mục tiêu cốt lõi:** Tối đa hóa chất lượng code, triệt tiêu thiên kiến tự đánh giá (Self-Confirmation Bias), kiểm soát nợ kỹ thuật (AQI $\ge 4.5/5.0$), và bảo vệ an toàn dòng tiền đầu tư.

---

## 1. Bối cảnh & Lý do Nâng cấp

Mô hình 2-Tier cũ (v2.0) chỉ có 1 lần gọi GPT ở đầu (Architect) và để Gemini Flash vừa viết code vừa tự kiểm thử ở cuối. Mô hình này bộc lộ 3 điểm yếu lớn:
1. **Khoảng cách giữa Bản vẽ và Code (Spec-to-Code Gap):** Architect ra quyết định trước khi thấy code thực tế, còn Gemini thi công đôi khi đi chệch kiến trúc ngầm.
2. **Vừa đá bóng vừa thổi còi (Author-as-Judge Bias):** Gemini tự viết code rồi tự review code của chính nó, tạo ra vùng mù đối với các lỗi logic tinh vi, race conditions, và memory leaks.
3. **Thiếu kiểm thử đối kháng (Adversarial Testing):** Test suite cơ bản chỉ kiểm tra happy path, thiếu các kịch bản hóc búa để ép bộc lộ điểm yếu.

Mô hình v3.0 giải quyết triệt để bằng cách đưa **Kỹ sư thứ 2 (GPT QA & AQI Doctor)** vào làm đối trọng độc lập.

---

## 2. Chi tiết 5 Giai đoạn Vận hành (The 5-Stage Architecture)

```text
[GĐ 1: Context Ingestion] ➔ [GĐ 2: GPT Architect] ➔ [GĐ 3: Gemini Execution] 
                          ➔ [GĐ 4: GPT Adversary QA] ➔ [GĐ 5: Gemini Hardening] 
                          ➔ [COMPLETE / RELEASE GATE]
```

### Bảng phân vai và dữ liệu chuyển giao:

| Giai đoạn | Vai trò | Diễn viên | Ngữ cảnh đầu vào (Input) | Sản phẩm đầu ra (Output) |
| :---: | :--- | :---: | :--- | :--- |
| **GĐ 1** | **Chuẩn bị ngữ cảnh** | CodeGraph + CPU ($0) | Task user + Workspace AST | Skeletons, Schemas, Type interfaces, Call Graph (3.000 – 6.000 tokens sạch). |
| **GĐ 2** | **Kỹ sư Lập bản vẽ** | **GPT (Lần 1)** | Ngữ cảnh sạch từ GĐ 1 | 1. Technical Blueprint & File Contracts<br>2. 3–5 Golden Assertions cơ bản<br>3. Step-by-Step Directives cho Gemini. |
| **GĐ 3** | **Thực thi nền tảng** | **Gemini Flash** | Bản vẽ từ GĐ 2 | 1. Code trực tiếp vào các file<br>2. Chạy compiler (`tsc`), linter, test cơ bản ($0 CPU)<br>3. Script CPU đo sơ bộ vi phạm AQI. |
| **GĐ 4** | **Kỹ sư Kiểm thử & AQI** | **GPT (Lần 2)** | Full modified files + Callers + Báo cáo vi phạm AQI + Test logs | 1. **Adversarial Tests**: 2-3 unit tests hiểm hóc viết sẵn bằng code thật<br>2. **AQI Prescription**: Đơn thuốc xử lý nợ kỹ thuật<br>3. **Pure Function**: Thuật toán tối ưu (nếu có bottleneck). |
| **GĐ 5** | **Hoàn thiện & Chốt chặn** | **Gemini Flash** | Test cases & đơn thuốc từ GĐ 4 | 1. Nạp test đối kháng vào file `.test.ts`<br>2. Sửa code cho đến khi máy tính báo xanh 100%<br>3. Đo lại AQI $\ge 4.5/5.0$<br>4. Xuất trình bằng chứng thực tế cho Human Gate. |

---

## 3. Ranh giới Quyền hạn Sắt đá (Separation of Powers)

Để ngăn chặn gian lận và thiên vị:
1. **Quyền của Gemini ở GĐ 5:**
   - ĐƯỢC PHÉP chạy toàn bộ test suite trên CPU ($0 token).
   - ĐƯỢC PHÉP sửa code thực thi để pass test.
   - CẤM TUYỆT ĐỐI sửa đổi, làm yếu so sánh (e.g. `==` thành `>=`), hoặc xóa/comment-out bài test của GPT (`Anti-Specification-Gaming`).
   - Bằng chứng hoàn thành duy nhất: **Terminal Exit Code = 0**, không chấp nhận lời tự đánh giá bằng văn bản.
2. **Quyền của GPT ở GĐ 4:**
   - Đóng vai trò Auditor độc lập.
   - Không trực tiếp can thiệp file hệ thống (tránh ảo giác import, sai lệch version).
   - Mọi đề xuất tối ưu thuật toán nặng đều phải đóng gói dưới dạng **Hàm thuần túy (Pure Function)** để Gemini ráp nối.

---

## 4. Tích hợp Tối ưu Hóa Điểm AQI (Architecture Quality Index)

Kết hợp mô hình: **Máy đo khách quan ($0 CPU) + Bác sĩ chẩn đoán (GPT)**:
1. **Máy đo (Cuối GĐ 3):** Chạy `node scripts/harness/aqi.mjs` phát hiện danh sách vi phạm: `EXPLICIT_ANY`, `HIGH_COMPLEXITY`, `DEPENDENCY_CYCLE`, `DEBUG_OUTPUT`.
2. **Bác sĩ kê đơn (GĐ 4):** GPT phân tích AST và chỉ đạo Gemini cách cấu trúc lại code sạch.
3. **Nghiệm thu (GĐ 5):** Gemini refactor và CPU chạy lại script chứng minh điểm AQI tăng vọt lên $\ge 4.5/5.0$.

---

## 5. Định mức Token & Năng lực Tư duy (Token & Reasoning Matrix)

Cả hai kỹ sư đều là **Frontier Reasoning Models** (o1, o3-mini, GPT-5 / sol):

| Tham số | Kỹ sư GĐ 2 (Architect) | Kỹ sư GĐ 4 (Adversary QA) |
| :--- | :---: | :---: |
| **Input Context** | **3.000 – 6.000 tokens** (Khung xương, Schemas, Callers) | **8.000 – 15.000 tokens** (Full modified files, Test suite, AQI report) |
| **Reasoning Tokens (Ẩn)** | **2.000 – 4.000 tokens** (Tư duy kiến tạo) | **3.000 – 6.000 tokens** (Tư duy phá hoại / Red Team) |
| **Visible Output (Hiện)** | **1.500 – 2.500 tokens** (Blueprint & Contracts) | **1.200 – 2.000 tokens** (Executable test code & findings) |
| **`reasoning_effort`** | `medium` | `medium` (hoặc `high`) |
| **`max_completion_tokens`** | **12.000 tokens** | **16.000 tokens** |

---

## 6. Bộ Ngân sách Vòng lặp Mới (Autonomous Loop v3.0 Budget)

```typescript
export const AUTONOMOUS_LOOP_V3_BUDGET = {
  // 1. TÀI CHÍNH & TOKEN
  MAX_COST_USD: 1.00,                 // Trần an toàn tuyệt đối ($1.00)
  SOFT_ALERT_COST_USD: 0.50,          // Cảnh báo mềm
  MAX_TOKENS_PER_RUN: 120_000,        // Nâng từ 60k -> 120k (đáp ứng 2 lượt Reasoning)

  // 2. GIỚI HẠN VÒNG LẶP (Fail-Fast)
  GLOBAL_CYCLES_MAX: 2,               // Tối đa 2 chu kỳ toàn cục (tránh cù cưa)
  VERIFICATION_RETRY_MAX: 1,          // Gemini ở GĐ 3 chỉ sửa 1 lần
  QUALITY_REMEDIATION_MAX: 1,         // Gemini ở GĐ 5 chỉ sửa 1 lần theo QA

  // 3. HẰNG SỐ THỜI GIAN (Bảo vệ dòng tiền đầu tư)
  PER_COMMAND_TIMEOUT_SECONDS: 180,   // 3 phút cho từng lệnh test / Docker
  PER_REQUEST_TIMEOUT_SECONDS: 180,   // 3 phút cho từng lần GPT suy nghĩ
  GLOBAL_TASK_TIMEOUT_SECONDS: 2400,  // 40 PHÚT (Chống ngắt ngang gây lãng phí chi phí đã bỏ ra)
};
```

---

## 7. Kế hoạch Hành động Kế tiếp (Next Actions)

1. **Chuẩn bị prompt bối cảnh:** Đóng gói bản đặc tả này cùng với mã nguồn `server.py` hiện tại.
2. **Kích hoạt GPT:** Sử dụng công cụ `craft_technical_prompt_with_gpt` để GPT tự tối ưu lại chính mình (GĐ 2) và thiết kế công cụ `audit_and_break_code_with_gpt` (GĐ 4).
3. **Gemini thi công:** Lắp ráp mã nguồn Python vào `server.py`, cập nhật JSON schemas và kiểm thử kết nối MCP.

---

## 8. Đề xuất Thử nghiệm: Cơ chế Thử lại có Điều kiện (Smart Conditional 2nd Retry)

> [!NOTE]
> Mục này là đề xuất mở được ghi nhận từ thảo luận thực tế, chờ GPT (Layer 1 Architect) phản biện và đưa ra phán quyết kỹ thuật trước khi đóng băng thành code.

### 8.1. Cơ chế đề xuất
- **Mặc định:** Giữ trần an toàn nghiêm ngặt: `verificationRetryMax = 1` và `qualityRemediationMax = 1`.
- **Mở khóa động (Conditional Unlock):** Chỉ cho phép kích hoạt Retry lần 2 nếu và chỉ nếu kết quả lần 1 thể hiện **Tiến triển đơn điệu (Monotonic Error Reduction)**:
  - *Kịch bản được phép:* Lần 0 fail 3 tests $\rightarrow$ Lần 1 fail 1 test (số lỗi giảm rõ rệt, mô hình đang đi đúng hướng, chỉ sót lỗi nhỏ) $\rightarrow$ Cấp thêm Retry 2 để dọn nốt.
  - *Kịch bản bị cấm (Fail-Fast):* Lần 0 fail 1 test $\rightarrow$ Lần 1 fail 3 tests (số lỗi tăng lên, mô hình đang sửa bừa gây hoảng loạn / Code Thrashing) $\rightarrow$ Ngắt ngay lập tức sang `FAILED`, cấm Retry 2.

### 8.2. Các câu hỏi phản biện cần GPT phân tích
1. *Rủi ro Anti-Gaming:* Liệu số lượng test fail giảm có đồng nghĩa với chất lượng code đang tăng, hay mô hình có nguy cơ "ăn gian" (ví dụ: bọc `try/catch` nuốt lỗi để test pass ảo)?
2. *Cân đối Thời gian & Chi phí:* Rủi ro kéo dài task thêm 3–4 phút có xứng đáng với tỷ lệ cứu sống task hay không?
3. *Tiêu chí Định lượng:* Máy tính nên dựa trên tiêu chí nào để phân biệt giữa "tiến triển thực chất" và "tiến triển giả tạo"?

---

## 9. Phán quyết Chính thức & Hướng dẫn Đóng gói từ GPT Architect (Adversarial Review Verdicts)

| Đề xuất | Phán quyết từ GPT Architect | Quyết định Kỹ thuật Chính thức |
|---|---|---|
| **1. Giữ nguyên 10 Phases** | **CHẤP THUẬN CÓ ĐIỀU KIỆN** | Giữ nguyên enum `PhaseId` 10 phase canonical. GPT QA chạy dưới dạng read-only bounded auditor trong phase `REALITY_CHECK`. Quá trình đóng sau sửa chữa (`EXECUTE` $\rightarrow$ `VERIFY` $\rightarrow$ `REALITY_CHECK`) là **deterministic closure** trên CPU, tuyệt đối **không gọi GPT lần 3**. |
| **2. Conditional 2nd Retry** | **BÁC BỎ TRONG PRODUCTION** | Giữ cứng `verificationRetry <= 1` trong luồng thực thi. Thuật toán Monotonic Error Reduction dễ bị reward-hacking (xóa test, nuốt lỗi ngoại lệ, lỗi compiler che giấu test semantics). Thuật toán được ghi nhận ở chế độ **Shadow Telemetry** để thu thập dữ liệu, không cấp thêm chu kỳ sửa code. |
| **3. Timeout 40 phút (2400s)** | **CHẤP THUẬN KÈM BẢO VỆ TIẾN TRÌNH** | Áp dụng trần 2,400 giây kèm cơ chế dọn dẹp cây tiến trình phân cấp (`SIGTERM` $\rightarrow$ chờ 15 giây $\rightarrow$ `SIGKILL` toàn bộ process group `kill -9 -<PID>`) chống zombie process. Duy trì các trần liên kết nghiêm ngặt: $0.50, 60,000 tokens và `GLOBAL_CYCLES_MAX = 2`. |

