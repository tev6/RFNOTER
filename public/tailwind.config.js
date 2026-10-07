/**
 * Tailwind 配置。
 *
 * 【暗色模式怎么做的 —— 改之前先读这段】
 *
 * 界面上 90% 的颜色都是 Tailwind 的 `gray-*` 与 `bg-white`。要给它们逐个加
 * `dark:` 变体，等于在 4 个文件里改 250 处，漏一处就是一个刺眼的白块。
 * 所以这里把**颜色本身**改成 CSS 变量：`gray-500` 不再写死 `#6b7280`，
 * 而是 `rgb(var(--c-gray-500) / <alpha-value>)`。变量在 public/index.html 的
 * `:root` / `html.dark` 两处定义，于是：
 *
 *   1. 所有 `text-gray-500` / `bg-gray-100` / `border-gray-200` … 一处不改就跟着换肤；
 *   2. 暗色的具体取值集中在一处，调深浅不用翻代码；
 *   3. 类名不变 —— 这点很关键，app.js 里有 `classList.toggle('bg-gray-100')`
 *      这类**按类名判断状态**的代码，改类名会静默改变行为。
 *
 * 语义色（surface / scrim / ink）同理，但它们是"用途"而不是"色阶"：
 *   - surface：卡片、弹窗、吸顶/吸底栏的底色（浅色下是白）；
 *   - scrim：模态遮罩（浅色下是中灰）；
 *   - ink：深色浮层，比如左下角那条撤销提示（两套主题下都偏深）。
 *
 * 少数"彩色浅底"（蓝色的选择模式提示条、黄色的搜索高亮、绿色热力图）不适合反过来
 * 取色，所以单独加 `dark:` 变体处理 —— 这也是为什么这里需要 `darkMode: 'class'`。
 * 暗色状态挂在 `<html class="dark">` 上，由 js/theme.js 维护。
 */
tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                primary: '#3b82f6',
                danger: '#ef4444',
                success: '#10b981',
                ai: '#8b5cf6',
                note1: '#3b82f6',
                note2: '#10b981',
                note3: '#f59e0b',
                note4: '#ef4444',
                note5: '#8b5cf6',

                // 色阶：全部由主题变量驱动，见 index.html 的 :root / html.dark
                gray: {
                    50: 'rgb(var(--c-gray-50) / <alpha-value>)',
                    100: 'rgb(var(--c-gray-100) / <alpha-value>)',
                    200: 'rgb(var(--c-gray-200) / <alpha-value>)',
                    300: 'rgb(var(--c-gray-300) / <alpha-value>)',
                    400: 'rgb(var(--c-gray-400) / <alpha-value>)',
                    500: 'rgb(var(--c-gray-500) / <alpha-value>)',
                    600: 'rgb(var(--c-gray-600) / <alpha-value>)',
                    700: 'rgb(var(--c-gray-700) / <alpha-value>)',
                    800: 'rgb(var(--c-gray-800) / <alpha-value>)',
                    900: 'rgb(var(--c-gray-900) / <alpha-value>)'
                },

                // 用途色
                surface: 'rgb(var(--c-surface) / <alpha-value>)',
                scrim: 'rgb(var(--c-scrim) / <alpha-value>)',
                ink: 'rgb(var(--c-ink) / <alpha-value>)'
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
            },
            animation: {
                'fade-in': 'fadeIn 0.2s ease-in-out',
                'fade-out': 'fadeOut 0.2s ease-in-out',
                'slide-in': 'slideIn 0.25s ease-out',
                'slide-up': 'slideUp 0.25s ease-out',
                'bounce-in': 'bounceIn 0.3s ease-out',
                'pulse': 'pulse 1.5s ease-in-out infinite',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                fadeOut: {
                    '0%': { opacity: '1' },
                    '100%': { opacity: '0' },
                },
                slideIn: {
                    '0%': { transform: 'translateY(-10px)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                slideUp: {
                    '0%': { transform: 'translateY(20px)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                bounceIn: {
                    '0%': { transform: 'scale(0.95)', opacity: '0' },
                    '70%': { transform: 'scale(1.02)', opacity: '1' },
                    '100%': { transform: 'scale(1)', opacity: '1' },
                },
            }
        }
    }
}
