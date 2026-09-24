package com.yzfly.lightread

// 覆盖 `tauri android init` 生成的 MainActivity (CI 在 init 后复制进 gen/android)。
// edge-to-edge 下网页铺到系统栏之下; 旧版 System WebView (如 Android 12 + Chromium 135)
// 不给 env(safe-area-inset-*) 赋值, 这里把系统栏 + 刘海的实际尺寸 (CSS px) 经
// window.LightReadInsets 交给前端 src/services/systemBars.ts; 前端再按页面实际深浅
// 回调 setBarsDark 切换状态栏 / 导航栏图标颜色。

import android.graphics.Color
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  @Volatile
  private var insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(InsetsBridge(), "LightReadInsets")

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      fun css(px: Int) = px / density
      insetsJson = "{\"top\":${css(bars.top)},\"right\":${css(bars.right)}," +
        "\"bottom\":${css(bars.bottom)},\"left\":${css(bars.left)}}"
      (view as WebView).evaluateJavascript("window.__lightreadApplyInsets?.()", null)
      // 交还 WebView 自身的处理, 新版 Chromium 仍据此填充 env()
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  private var barsDark: Boolean? = null

  private fun applyBarsDark(dark: Boolean) {
    if (barsDark == dark) return
    barsDark = dark
    // 透明系统栏, 仅切换图标深浅; 背景由网页自身延伸到栏下
    val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
      else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
    enableEdgeToEdge(style, style)
  }

  private inner class InsetsBridge {
    @JavascriptInterface
    fun get(): String = insetsJson

    @JavascriptInterface
    fun setBarsDark(dark: Boolean) {
      runOnUiThread { applyBarsDark(dark) }
    }
  }
}
