import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Order Confirmation Jobs',
  description: 'Background job system for sending order confirmation emails.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
