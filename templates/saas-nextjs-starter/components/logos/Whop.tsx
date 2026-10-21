/**
 * Marca de Whop. Sin asset externo: se dibuja con texto para no depender
 * de una imagen que puede faltar.
 */
export default function Whop() {
  return (
    <div
      aria-label="Whop"
      className="flex h-[100px] w-[100px] items-center justify-center rounded-xl bg-[#FF6243] text-white"
    >
      <span className="text-lg font-bold tracking-tight">Whop</span>
    </div>
  );
}
