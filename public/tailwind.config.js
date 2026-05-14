tailwind.config = {
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
                note5: '#8b5cf6'
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
