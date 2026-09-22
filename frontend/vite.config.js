import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// اسم التطبيق كما هو معروض في الواجهة (نبض | إدارة العيادات)
const APP_NAME = 'نبض | إدارة العيادات'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // تحديث آمن: لا استبدال صامت للنسخة القديمة — نعرض إشعار "يتوفر تحديث"
      registerType: 'prompt',
      injectRegister: false,          // التسجيل يدوي عبر virtual:pwa-register في UpdateNotice
      filename: 'sw.js',              // اسم ملف الـ Service Worker (افتراضي صريح)
      manifestFilename: 'manifest.webmanifest',  // اسم ملف الـ Web App Manifest
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png', 'icons/icon-32.png'],
      manifest: {
        id: '/',
        name: APP_NAME,
        short_name: 'نبض',
        description: 'نظام إدارة العيادات والمراكز الطبية: المرضى، المواعيد، الزيارات، الوصفات، الفواتير والتقارير.',
        lang: 'ar',
        dir: 'rtl',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f4f7f6',
        theme_color: '#173c3d',
        categories: ['medical', 'health', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // تخزين هيكل التطبيق فقط (HTML/JS/CSS/أيقونات/خطوط) — لا شيء غير ذلك
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        // حماية صريحة: أي طلب API أو ملف مرفوع أو فحص صحة لا يمر عبر الكاش
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//, /^\/health$/],
        cleanupOutdatedCaches: true,
        // مع registerType: 'prompt' نُبقي التفعيل بيد المستخدم
        skipWaiting: false,
        clientsClaim: false,
        runtimeCaching: [
          {
            // خطوط الويب فقط: أصول ثابتة عامة (لا بيانات مرضى ولا صلاحيات ولا توكنات)
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'nabd-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'nabd-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // لا Service Worker أثناء التطوير — يمنع أي كاش مزعج أو بيانات قديمة محلياً
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // توجيه طلبات الواجهة الخلفية عبر نفس المنشأ لتجنب مشاكل CORS
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})
