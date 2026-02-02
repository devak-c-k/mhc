'use client';

import { useState } from 'react';

// Common interface for result object
interface ScraperResult {
  cnr: string;
  status: 'pending' | 'processing' | 'completed';
  success?: boolean;
  error?: string;
  data?: any;
  html?: string;
  screenshot?: string; // Base64 screenshot for manual solving if needed
}

export default function Home() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ScraperResult[]>([]);

  const handleSearch = async () => {
    if (!input.trim()) return;

    setLoading(true);
    const cnrs = input.split('\n').filter(line => line.trim() !== '').map(s => s.trim());
    
    // Initialize results with pending state
    const initialResults: ScraperResult[] = cnrs.map(cnr => ({ cnr, status: 'pending', success: false }));
    setResults(initialResults);

    const CONCURRENCY = 2;
    let currentIndex = 0;

    const processNext = async () => {
        if (currentIndex >= cnrs.length) return;
        
        const index = currentIndex++;
        const cnr = cnrs[index];

        // Update to processing
        setResults(prev => {
            const next = [...prev];
            next[index] = { ...next[index], status: 'processing' };
            return next;
        });

        try {
            const res = await fetch('/api/scrape', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cnrs: [cnr] }),
            });
            const data = await res.json();
            
            setResults(prev => {
                const next = [...prev];
                // Handle success
                if (res.ok && data.results && data.results.length > 0) {
                     // Check if specific result has error despite 200 OK
                     const resultData = data.results[0];
                     if (resultData.success === false) {
                        next[index] = { ...resultData, status: 'completed', error: resultData.error || 'Operation failed' };
                     } else {
                        next[index] = { ...resultData, status: 'completed', success: true };
                     }
                } else {
                     // Handle API level error
                     next[index] = { 
                         cnr, 
                         success: false, 
                         error: data.error ? JSON.stringify(data.error) : 'Unknown API Error', 
                         status: 'completed' 
                     };
                }
                return next;
            });

        } catch (e: any) {
             setResults(prev => {
                const next = [...prev];
                next[index] = { cnr, success: false, error: e.message || 'Network Error', status: 'completed' };
                return next;
            });
        }
        
        await processNext();
    };

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, cnrs.length); i++) {
        workers.push(processNext());
    }

    await Promise.all(workers);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-8">
        
        <header className="text-center space-y-2">
          <p className="text-slate-500">Enter CNR numbers below (one per line)</p>
        </header>

        <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
          <textarea
            className="w-full h-32 p-4 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none resize-y font-mono text-sm"
            placeholder="HCMA011030172014"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="mt-4 flex justify-end">
            <button
              onClick={handleSearch}
              disabled={loading}
              className={`px-6 py-2.5 rounded-lg font-medium text-white transition-all
                ${loading 
                  ? 'bg-slate-400 cursor-not-allowed' 
                  : 'bg-blue-600 hover:bg-blue-700 shadow-md hover:shadow-lg active:transform active:scale-95'
                }`}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing...
                </span>
              ) : 'Search Cases'}
            </button>
          </div>
        </section>

        <section className="space-y-4">
          {results.map((result, idx) => (
            <div key={idx} className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
              <div className={`px-6 py-4 border-b ${
                  result.status === 'processing' ? 'bg-blue-50 border-blue-100' :
                  result.status === 'pending' ? 'bg-gray-50 border-gray-100' :
                  result.success ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'
              } flex justify-between items-center`}>
                <h3 className="font-mono font-bold text-slate-700">{result.cnr}</h3>
                <div className="flex items-center gap-2">
                    {result.status === 'completed' && !result.success && (
                        <span className="text-xs text-red-600 font-mono hidden md:inline-block truncate max-w-[200px]" title={result.error}>
                             {result.error}
                        </span>
                    )}
                    <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                        result.status === 'processing' ? 'bg-blue-100 text-blue-700' :
                        result.status === 'pending' ? 'bg-gray-200 text-gray-600' :
                        result.success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>
                    {result.status === 'processing' ? 'Processing...' : 
                    result.status === 'pending' ? 'Pending' :
                    result.success ? 'Success' : 'Failed'}
                    </span>
                </div>
              </div>
              
              <div className="p-6">
                {result.status === 'pending' && (
                    <div className="text-slate-400 italic text-sm text-center py-8">Waiting in queue...</div>
                )}
                
                {result.status === 'processing' && (
                    <div className="flex flex-col items-center justify-center py-8 space-y-3">
                         <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span className="text-blue-600 font-medium animate-pulse">Scraping data...</span>
                    </div>
                )}

                {result.status === 'completed' && !result.success && (
                   <div className="text-red-600 font-medium bg-red-50 p-4 rounded-lg border border-red-100">
                        <p className="font-bold flex items-center gap-2">
                             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                             Scraping Failed
                        </p>
                        <p className="mt-2 text-sm text-slate-700 font-mono">{result.error || "Unknown Failure"}</p>
                        <p className="text-xs text-slate-500 mt-2 italic">
                            Retrying might succeed if it was a temporary CAPTCHA failure.
                        </p>
                   </div>
                )}
                
                {result.status === 'completed' && result.success && (
                  <ResultTabs result={result} />
                )}
              </div>
            </div>
          ))}
        </section>

      </div>
    </div>
  );
}

function ResultTabs({ result }: { result: any }) {
  const [activeTab, setActiveTab] = useState<'json' | 'html'>('json');

  return (
    <div>
      <div className="flex space-x-4 border-b border-slate-200 mb-6">
        <button
          onClick={() => setActiveTab('json')}
          className={`pb-2 text-sm font-medium transition-colors ${activeTab === 'json' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
        >
          JSON Data
        </button>
        <button
          onClick={() => setActiveTab('html')}
          className={`pb-2 text-sm font-medium transition-colors ${activeTab === 'html' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
        >
          Raw HTML
        </button>
      </div>

      <div className="min-h-[200px]">
        {activeTab === 'json' && (
          <div className="bg-slate-900 rounded-lg p-4 overflow-auto max-h-[600px]">
            <pre className="text-xs font-mono text-green-400 whitespace-pre-wrap break-all">
              {JSON.stringify(result.data, null, 2)}
            </pre>
          </div>
        )}

        {activeTab === 'html' && (
          <div className="border border-slate-200 rounded-lg overflow-hidden h-96">
            <iframe
              srcDoc={result.html}
              className="w-full h-full"
              sandbox="allow-same-origin"
              title="Raw HTML Result"
            />
          </div>
        )}
      </div>
    </div>
  );
}
