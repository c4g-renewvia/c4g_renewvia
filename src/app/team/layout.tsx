export default function TeamLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className='container mx-auto px-4 py-8'>
      <div className='mt-6'>{children}</div>
    </div>
  );
}
