import { Navigate, useLocation } from 'react-router-dom';
import { nativeTaskFallback } from '@/lib/nativeTaskLinks';

export default function NativeTaskBridge() {
  const location = useLocation();
  return <Navigate replace to={nativeTaskFallback(location.pathname, location.search)} />;
}
