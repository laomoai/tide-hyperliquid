import type {Metadata} from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Tide - 量化交易终端',
  description: 'Tide - 量化交易终端',
  icons: { icon: '/tide.svg' },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="zh" className={`dark ${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans antialiased text-text-main bg-bg-main flex h-screen overflow-hidden" suppressHydrationWarning>
        <div className="flex-1 flex flex-col relative overflow-hidden h-full">
          {children}
        </div>
      </body>
    </html>
  );
}
