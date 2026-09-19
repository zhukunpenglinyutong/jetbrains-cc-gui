import React, { useState } from "react";

export function ProjectAvatar({ githubOwner, letter, size = "w-8 h-8" }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (githubOwner && !imageFailed) {
    return (
      <img
        src={`https://github.com/${encodeURIComponent(githubOwner)}.png?size=80`}
        alt=""
        loading="lazy"
        onError={() => setImageFailed(true)}
        className={`${size} rounded-md object-cover bg-oai-gray-100 dark:bg-oai-gray-800 flex-shrink-0`}
      />
    );
  }
  return (
    <div
      className={`${size} rounded-md oai-bg-elevated flex items-center justify-center oai-text-caption font-medium text-oai-gray-500 dark:text-oai-gray-300 flex-shrink-0`}
    >
      {letter}
    </div>
  );
}
