export function Wordmark() {
  return (
    <a href="#top" className="sw-wordmark" aria-label="SafeWatch home">
      <svg className="sw-wordmark__mark" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2.500 4 5.600v5.800c0 4.800 3.300 8.400 8 10.100 4.700-1.700 8-5.300 8-10.100V5.600z" stroke="currentColor" strokeWidth="1.700" strokeLinejoin="round" />
        <path d="M10 8.800v6.400l5.400-3.200z" fill="currentColor" />
      </svg>
      <span>Safe<span className="sw-wordmark__soft">Watch</span></span>
    </a>
  );
}
