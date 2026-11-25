import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'

const SAMPLE_MARKDOWN = [
    '# Markdown math fixture',
    '',
    String.raw`Inline: \(x^2 + y^2\)`,
    '',
    String.raw`\[`,
    String.raw`\lim_{x\to 0}\frac{\sin x}{x}=1`,
    String.raw`\]`,
    '',
    '```latex',
    '\\[x^2\\]',
    '```',
].join('\n')

const CLOCK_MARKDOWN = String.raw`> 时针 $OM$ 与分针 $ON$，$1\text{ h}$ 之内，$\angle MON = 90^\circ$。

- 分针领先时针 **$60^\circ$**；速度差 $6 - 0.5 = \mathbf{5.5^\circ/\text{min}}$。
- 设经过 $t\text{ min}$（$0 < t \le 60$），$t = \frac{420}{11}$。

$$\mathbf{\frac{60}{11}\text{ 或 }\frac{420}{11}}$$

费用 $200 和 $80。`

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <I18nProvider>
                <div data-testid="markdown-math-fixture">
                    <MarkdownRenderer content={SAMPLE_MARKDOWN} standalone />
                </div>
                <div data-testid="clock-math-fixture">
                    <MarkdownRenderer content={CLOCK_MARKDOWN} />
                </div>
            </I18nProvider>
        </React.StrictMode>
    )
}
