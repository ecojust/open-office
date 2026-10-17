//! Public AppKit/PDFKit print APIs, always called on the application thread.
use super::PrintResult;
use objc2::{
    extern_class, extern_methods,
    rc::{Allocated, Retained},
    AllocAnyThread, MainThreadMarker,
};
use objc2_app_kit::{NSPrintInfo, NSPrintOperation};
use objc2_foundation::{NSCopying, NSData, NSObject, NSString};
use objc2_web_kit::WKWebView;

// Only these public PDFKit selectors are needed. Keep the small typed binding
// local instead of introducing another PDF parser or an external viewer.
#[link(name = "PDFKit", kind = "framework")]
extern "C" {}

extern_class!(
    #[unsafe(super(NSObject))]
    struct PDFDocument;
);

impl PDFDocument {
    extern_methods!(
        #[unsafe(method(initWithData:))]
        #[unsafe(method_family = init)]
        unsafe fn init_with_data(this: Allocated<Self>, data: &NSData) -> Option<Retained<Self>>;
        #[unsafe(method(pageCount))]
        #[unsafe(method_family = none)]
        unsafe fn page_count(&self) -> usize;
        #[unsafe(method(isLocked))]
        #[unsafe(method_family = none)]
        unsafe fn is_locked(&self) -> bool;
        #[unsafe(method(allowsPrinting))]
        #[unsafe(method_family = none)]
        unsafe fn allows_printing(&self) -> bool;
        #[unsafe(method(printOperationForPrintInfo:scalingMode:autoRotate:))]
        #[unsafe(method_family = none)]
        unsafe fn print_operation(
            &self,
            print_info: &NSPrintInfo,
            scaling_mode: isize,
            auto_rotate: bool,
        ) -> Option<Retained<NSPrintOperation>>;
    );
}

fn run(operation: &NSPrintOperation, title: &str) -> Result<PrintResult, String> {
    operation.setShowsPrintPanel(true);
    operation.setShowsProgressPanel(true);
    operation.setJobTitle(Some(&NSString::from_str(title)));
    // runOperation keeps document/view ownership valid until printing or user
    // cancellation finishes; a false result is also how AppKit reports Cancel.
    Ok(PrintResult {
        status: if operation.runOperation() {
            "completed"
        } else {
            "cancelled"
        },
    })
}

pub fn print_pdf(bytes: &[u8], title: &str) -> Result<PrintResult, String> {
    let mtm = MainThreadMarker::new().ok_or("系统打印必须在主线程执行。")?;
    if NSPrintOperation::currentOperation(mtm).is_some() {
        return Err("系统已有打印对话框，请先完成或取消。".into());
    }
    let data = NSData::with_bytes(bytes);
    // SAFETY: public PDFKit methods, valid retained NSData, main-thread caller.
    let document = unsafe { PDFDocument::init_with_data(PDFDocument::alloc(), &data) }
        .ok_or("无法读取用于打印的 PDF 文档。")?;
    if unsafe { document.is_locked() } {
        return Err("PDF 文档尚未解锁，无法打印。".into());
    }
    if unsafe { document.page_count() } == 0 || !unsafe { document.allows_printing() } {
        return Err("PDF 文档没有可打印的页面，或文档权限不允许打印。".into());
    }
    let info = NSPrintInfo::sharedPrintInfo().copy();
    // PDFPrintScalingMode::PageScaleDownToFit = 2: preserve vectors and original
    // size where possible, fitting oversized pages to the selected paper.
    let operation = unsafe { document.print_operation(&info, 2, true) }
        .ok_or("系统无法创建此 PDF 文档的打印任务。")?;
    run(&operation, title)
}

pub fn print_html(pointer: *mut std::ffi::c_void) -> Result<PrintResult, String> {
    let mtm = MainThreadMarker::new().ok_or("系统打印必须在主线程执行。")?;
    if pointer.is_null() {
        return Err("文档打印视图已关闭。".into());
    }
    if NSPrintOperation::currentOperation(mtm).is_some() {
        return Err("系统已有打印对话框，请先完成或取消。".into());
    }
    // SAFETY: Tauri supplies the live WKWebView in a main-thread callback.
    let view = unsafe { &*pointer.cast::<WKWebView>() };
    let info = NSPrintInfo::sharedPrintInfo().copy();
    // WKWebView applies the page's @media print stylesheet. Its native print
    // operation is supported by every macOS version targeted by this app.
    let operation = unsafe { view.printOperationWithPrintInfo(&info) };
    run(&operation, "文档打印")
}
